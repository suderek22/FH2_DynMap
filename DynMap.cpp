// DynMap: live 2D map of Forza Horizon 2 served on a local web server.
// Alpha: only the host player is published.
#include "fh2mod.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <mutex>
#include <algorithm>
#include <string>
#include <vector>
#include <thread>

#include "favicon_png.h"

extern "C" IMAGE_DOS_HEADER __ImageBase;

namespace {

constexpr char kVersion[] = "0.2.0";
constexpr char kSettingKey[] = "DynMapEnabled";

// Same HUD hook as VirtualDashboard: rax = car-state object, [rdi+0xE8] = the car.
constexpr std::uintptr_t kHudHookRva = 0x783E67;
constexpr std::uintptr_t kHudCarOffset = 0xE8;
constexpr std::uintptr_t kNameOffset = 0x350;   // car -> media name string
constexpr std::uintptr_t kStateOffset = 0x4C08; // car -> car-state object
constexpr std::uintptr_t kSpeed = 0xE28;        // m/s
constexpr std::uintptr_t kPos = 0xEF0;          // x, y(height), z

struct Sample {
    bool valid = false;
    char car[64] = {};
    float pos[3] = {};
    float speed = 0;
};

// World metres -> map pixels (7168x4096): px = ax*x + bx, py = az*z + bz.
// Default from the game's map profile: the map is 12000 m wide with its top-left corner at
// world (-7500, -11000), i.e. 7168/12000 px per metre.
constexpr double kDefBx = 2555.30502;
constexpr double kDefBz = 327.298182;
constexpr double kDefAx = 0.342617167;
constexpr double kDefAz = -0.343337966;
struct Calib {
    double ax = kDefAx, bx = kDefBx, az = kDefAz, bz = kDefBz;
};

const FH2ModApi* g_api = nullptr;
FH2Mod* g_mod = nullptr;
std::uint8_t* g_exe = nullptr;
std::filesystem::path g_ini_path;
std::filesystem::path g_web_root;
std::atomic<bool> g_enabled{true};
std::atomic<int> g_port{8090};
std::atomic<bool> g_lan{true};
std::atomic<std::uint64_t> g_last_sample{0};
std::atomic<const void*> g_car{nullptr};
char g_car_name[64] = {};

std::mutex g_mutex;
Sample g_sample;
Calib g_calib;
std::string g_player_name = "Host";
std::atomic<int> g_wristband{0};

void logf(const char* fmt, ...) {
    char buf[512];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    g_api->log(g_mod, buf);
}

void read_name(const std::uint8_t* c, char* out) {
    out[0] = 0;
    __try {
        const std::uint64_t cap =
            *reinterpret_cast<const std::uint64_t*>(c + kNameOffset + 0x18);
        const char* name = cap >= 16
            ? *reinterpret_cast<const char* const*>(c + kNameOffset)
            : reinterpret_cast<const char*>(c + kNameOffset);
        int n = 0;
        while (n < 63 && name[n] >= 0x20 && name[n] < 0x7f) {
            out[n] = name[n];
            ++n;
        }
        out[n] = 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        out[0] = 0;
    }
}

bool read_sample(const void* car, const void* state, Sample* t) {
    __try {
        const auto* c = static_cast<const std::uint8_t*>(car);
        const auto* s = static_cast<const std::uint8_t*>(state);
        if (!c || !s) return false;
        t->speed = *reinterpret_cast<const float*>(s + kSpeed);
        for (int i = 0; i < 3; ++i)
            t->pos[i] = *reinterpret_cast<const float*>(s + kPos + 4 * i);
        for (float v : t->pos)
            if (!std::isfinite(v) || std::fabs(v) > 1e7f) return false;
        read_name(c, t->car);
        t->valid = true;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

void publish(const Sample& s) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_sample = s;
}

// ---- Drivatars (demo of multiple players) ----
// ForzaCar's per-frame update (rcx = car). Car kind at car+0x4D08: 0 local player, 1 Drivatar, 2 traffic.
constexpr std::uintptr_t kCarKindRva = 0xF62280; // int(car), called constantly for every car
constexpr std::uintptr_t kKindOffset = 0x4D08;
constexpr int kMaxAi = 64;
constexpr std::uint64_t kAiExpireMs = 1500;
struct AiCar {
    const void* car = nullptr;
    std::uint64_t tick = 0;
    int id = 0;
    Sample s;
};
AiCar g_ai[kMaxAi];
std::mutex g_ai_mutex;
int g_next_ai_id = 2;
std::atomic<bool> g_show_ai{true};
std::vector<std::string> g_ai_names;

// Drivatar gamertags: media\DrivatarGlobalCache\DefaultCache.bin, 125 records of 9816 bytes after an
// 8-byte header, each starting with a 16-character UTF-16 gamertag.
void load_ai_names() {
    std::vector<wchar_t> p(MAX_PATH * 2);
    GetModuleFileNameW(nullptr, p.data(), static_cast<DWORD>(p.size()));
    std::filesystem::path f = std::filesystem::path(p.data()).parent_path() / L"media" /
                              L"DrivatarGlobalCache" / L"DefaultCache.bin";
    std::ifstream in(f, std::ios::binary);
    if (!in) { logf("Drivatar name cache not found (%ls); using fallback names.", f.c_str()); return; }
    std::vector<char> b((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    constexpr std::size_t kHead = 8, kRec = 9816;
    for (std::size_t o = kHead; o + 32 <= b.size(); o += kRec) {
        std::wstring w(reinterpret_cast<const wchar_t*>(b.data() + o), 16);
        w.resize(wcsnlen(w.c_str(), 16));
        if (w.empty()) continue;
        const int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
        std::string s(n > 0 ? n - 1 : 0, 0);
        if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, s.data(), n, nullptr, nullptr);
        if (!s.empty() && std::find(g_ai_names.begin(), g_ai_names.end(), s) == g_ai_names.end())
            g_ai_names.push_back(s);
    }
    logf("Loaded %zu Drivatar gamertags.", g_ai_names.size());
}
int g_name_probes = 0;

// Logs readable strings inside a Drivatar's car object, to locate where its driver name lives.
void probe_strings(const std::uint8_t* c) {
    __try {
        int found = 0;
        for (int i = 0; i < 0x5000 && found < 24;) {
            int n = 0;
            while (i + n < 0x5000 && c[i + n] >= 0x20 && c[i + n] < 0x7f) ++n;
            if (n >= 5) {
                char b[64] = {};
                std::memcpy(b, c + i, n < 63 ? n : 63);
                logf("  car+0x%X ascii \"%s\"", i, b);
                ++found;
            }
            i += n ? n : 1;
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

bool read_ai_kind_state(const void* car, const void** state) {
    __try {
        const auto* c = static_cast<const std::uint8_t*>(car);
        if (*reinterpret_cast<const int*>(c + kKindOffset) != 1) return false;
        *state = *reinterpret_cast<void* const*>(c + kStateOffset);
        return *state != nullptr;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

int (*g_kind_orig)(void*) = nullptr;
void note_car(const void* car);

int car_kind_detour(void* car) {
    note_car(car);
    return g_kind_orig(car);
}

void note_car(const void* car) {
    if (!g_enabled.load() || !g_show_ai.load()) return;
    if (!car) return;
    const std::uint64_t now = GetTickCount64();
    {
        std::lock_guard<std::mutex> lock(g_ai_mutex);
        for (const AiCar& a : g_ai)
            if (a.car == car && now - a.tick < 100) return;
    }
    Sample t;
    const void* state = nullptr;
    if (!read_ai_kind_state(car, &state)) return;
    if (!read_sample(car, state, &t) || !t.car[0]) return;
    std::lock_guard<std::mutex> lock(g_ai_mutex);
    AiCar* slot = nullptr;
    for (AiCar& a : g_ai)
        if (a.car == car) { slot = &a; break; }
    if (!slot)
        for (AiCar& a : g_ai)
            if (!a.car || now - a.tick > kAiExpireMs) { slot = &a; break; }
    if (!slot) return;
    if (slot->car != car) {
        slot->car = car;
        slot->id = g_next_ai_id++;
        if (g_name_probes < 3) {
            ++g_name_probes;
            logf("Drivatar #%d: %s", slot->id, t.car);
            probe_strings(static_cast<const std::uint8_t*>(car));
        }
    }
    slot->tick = now;
    slot->s = t;
}

void hud_hook(FH2Context* ctx, void*) {
    if (!g_enabled.load()) return;
    const std::uint64_t now = GetTickCount64();
    if (now - g_last_sample.load() < 30) return;
    const void* car = nullptr;
    __try {
        car = *reinterpret_cast<void* const*>(
            reinterpret_cast<const std::uint8_t*>(ctx->rdi) + kHudCarOffset);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return;
    }
    Sample t;
    if (!read_sample(car, reinterpret_cast<const void*>(ctx->rax), &t)) return;
    g_last_sample.store(now);
    static std::uint64_t last_log = 0;
    if (now - last_log > 15000) {
        last_log = now;
        logf("Position x=%.0f y=%.0f z=%.0f", t.pos[0], t.pos[1], t.pos[2]);
    }
    std::memcpy(g_car_name, t.car, sizeof(g_car_name));
    g_car.store(car);
    publish(t);
}

// The HUD hook is silent in menus: keep the last car alive by re-reading memory only.
void watchdog() {
    for (;;) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        if (GetTickCount64() - g_last_sample.load() <= 100) continue;
        const void* car = g_car.load();
        Sample t;
        bool ok = false;
        if (car) {
            __try {
                const void* state = *reinterpret_cast<void* const*>(
                    static_cast<const std::uint8_t*>(car) + kStateOffset);
                ok = read_sample(car, state, &t) && t.car[0] &&
                     std::strcmp(t.car, g_car_name) == 0;
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                ok = false;
            }
        }
        if (ok) {
            publish(t);
        } else {
            g_car.store(nullptr);
            publish(Sample{});
        }
    }
}

void install_hook() {
    void* base = g_api->wait_for_code(120000);
    if (!base) {
        logf("Timed out waiting for game code.");
        return;
    }
    g_exe = static_cast<std::uint8_t*>(base);
    if (g_api->api_version < 7 || !g_api->hook_instruction) {
        logf("This platform has no instruction hooks; update the platform.");
        return;
    }
    FH2Hook* h = g_api->hook_instruction(g_mod, "DynMap: HUD speedometer update",
                                         g_exe + kHudHookRva, hud_hook, nullptr);
    if (!h || !g_api->enable_hooks(g_mod, h)) {
        logf("Could not install the HUD hook.");
        return;
    }
    logf("Position hook active.");
    if (g_show_ai.load()) {
        load_ai_names();
        FH2Hook* a = g_api->hook_function(g_mod, "DynMap: car kind (Drivatars)", g_exe + kCarKindRva,
                                          reinterpret_cast<void*>(car_kind_detour),
                                          reinterpret_cast<void**>(&g_kind_orig));
        if (!a || !g_api->enable_hooks(g_mod, a)) logf("Could not install the Drivatar hook.");
        else logf("Drivatar hook active.");
    }
}

std::string json_escape(const std::string& s) {
    std::string o;
    for (char c : s) {
        if (c == '"' || c == '\\') o += '\\';
        if (static_cast<unsigned char>(c) >= 0x20) o += c;
    }
    return o;
}

std::string state_json() {
    Sample s;
    Calib c;
    std::string name;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        s = g_sample;
        c = g_calib;
        name = g_player_name;
    }
    char buf[1024];
    std::string players = "[";
    if (s.valid) {
        std::snprintf(buf, sizeof(buf),
                      "{\"id\":1,\"name\":\"%s\",\"car\":\"%s\",\"x\":%.2f,\"y\":%.2f,"
                      "\"z\":%.2f,\"speed\":%.2f,\"host\":true,\"wb\":%d}",
                      json_escape(name).c_str(), json_escape(s.car).c_str(), s.pos[0],
                      s.pos[1], s.pos[2], s.speed, g_wristband.load());
        players += buf;
    }
    if (g_show_ai.load()) {
        // Gamertags come from the game cache; the pairing with cars and the wristband are simulated.
        static const char* const kNames[] = {
            "Marco Rossi", "Lea Dubois", "Nico_Drift", "Sofia V", "Hugo Martin", "Giulia R",
            "TurboTom", "Elena F", "Luca B", "Chloe Petit", "Matteo G", "Zoe Laurent",
            "Dario K", "Ines Moreau", "Paolo S", "Jade L", "Enzo Bianchi", "Mila R",
            "Theo Garnier", "Anna M", "Rico_77", "Camille B", "Fabio N", "Alice D"};
        const std::uint64_t now = GetTickCount64();
        std::lock_guard<std::mutex> lock(g_ai_mutex);
        for (const AiCar& a : g_ai) {
            if (!a.car || now - a.tick > kAiExpireMs) continue;
            std::snprintf(buf, sizeof(buf),
                          "%s{\"id\":%d,\"name\":\"%s\",\"car\":\"%s\",\"x\":%.2f,\"y\":%.2f,"
                          "\"z\":%.2f,\"speed\":%.2f,\"ai\":true,\"wb\":%d}",
                          players.size() > 1 ? "," : "", a.id,
                          json_escape(g_ai_names.empty() ? std::string(kNames[a.id % (sizeof(kNames) / sizeof(kNames[0]))]) : g_ai_names[(a.id * 7) % g_ai_names.size()]).c_str(),
                          json_escape(a.s.car).c_str(), a.s.pos[0], a.s.pos[1], a.s.pos[2],
                          a.s.speed, 1 + (a.id * 5 + a.id / 7) % 7);
            players += buf;
        }
    }
    players += "]";
    std::snprintf(buf, sizeof(buf),
                  "{\"version\":\"%s\",\"session\":\"local\",\"calib\":{\"ax\":%.9g,"
                  "\"bx\":%.9g,\"az\":%.9g,\"bz\":%.9g},\"players\":",
                  kVersion, c.ax, c.bx, c.az, c.bz);
    return std::string(buf) + players + "}";
}

void save_calib(const Calib& c) {
    const auto put = [](const wchar_t* key, double v) {
        wchar_t b[64];
        swprintf(b, 64, L"%.9g", v);
        WritePrivateProfileStringW(L"DynMap", key, b, g_ini_path.c_str());
    };
    put(L"Ax", c.ax);
    put(L"Bx", c.bx);
    put(L"Az", c.az);
    put(L"Bz", c.bz);
}

double load_double(const wchar_t* key, double def) {
    wchar_t b[64] = {};
    GetPrivateProfileStringW(L"DynMap", key, L"", b, 64, g_ini_path.c_str());
    if (!b[0]) return def;
    wchar_t* end = nullptr;
    const double v = std::wcstod(b, &end);
    return (end != b && std::isfinite(v)) ? v : def;
}

bool query_double(const std::string& q, const char* key, double* out) {
    const std::string k = std::string(key) + "=";
    std::size_t p = 0;
    while ((p = q.find(k, p)) != std::string::npos) {
        if (p == 0 || q[p - 1] == '&' || q[p - 1] == '?') {
            char* end = nullptr;
            const double v = std::strtod(q.c_str() + p + k.size(), &end);
            if (end != q.c_str() + p + k.size() && std::isfinite(v)) {
                *out = v;
                return true;
            }
            return false;
        }
        p += k.size();
    }
    return false;
}

void send_all(SOCKET s, const char* data, int len) {
    while (len > 0) {
        const int n = send(s, data, len, 0);
        if (n <= 0) return;
        data += n;
        len -= n;
    }
}

void reply(SOCKET s, const char* status, const char* type, const std::string& body,
           bool cache = false) {
    char head[320];
    const int n = std::snprintf(
        head, sizeof(head),
        "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\n"
        "Cache-Control: %s\r\nAccess-Control-Allow-Origin: *\r\n"
        "Connection: close\r\n\r\n",
        status, type, body.size(), cache ? "public, max-age=86400" : "no-store");
    send_all(s, head, n);
    send_all(s, body.data(), static_cast<int>(body.size()));
}

const char* mime_for(const std::string& ext) {
    if (ext == ".html") return "text/html; charset=utf-8";
    if (ext == ".js") return "application/javascript; charset=utf-8";
    if (ext == ".css") return "text/css; charset=utf-8";
    if (ext == ".png") return "image/png";
    if (ext == ".jpg") return "image/jpeg";
    if (ext == ".json") return "application/json";
    return "application/octet-stream";
}

bool serve_file(SOCKET s, std::string rel) {
    if (rel.empty() || rel == "/") rel = "/index.html";
    if (rel.find("..") != std::string::npos || rel.find('\\') != std::string::npos ||
        rel.find(':') != std::string::npos) {
        return false;
    }
    std::filesystem::path p = g_web_root;
    p /= std::filesystem::path(rel.substr(1)).make_preferred();
    std::ifstream f(p, std::ios::binary);
    if (!f) return false;
    std::string body((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    const bool cache = rel.rfind("/tiles/", 0) == 0 || rel.rfind("/icons/", 0) == 0;
    reply(s, "200 OK", mime_for(p.extension().string()), body, cache);
    return true;
}

void handle_client(SOCKET s) {
    DWORD timeout = 3000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout));
    char req[2048];
    const int n = recv(s, req, sizeof(req) - 1, 0);
    if (n > 0) {
        req[n] = 0;
        std::string line(req, std::strcspn(req, "\r\n"));
        std::string target;
        if (line.rfind("GET ", 0) == 0) {
            const std::size_t e = line.find(' ', 4);
            target = line.substr(4, e == std::string::npos ? std::string::npos : e - 4);
        }
        std::string path = target, query;
        const std::size_t qm = target.find('?');
        if (qm != std::string::npos) {
            path = target.substr(0, qm);
            query = target.substr(qm + 1);
        }
        if (target.empty()) {
            reply(s, "405 Method Not Allowed", "text/plain", "GET only");
        } else if (!g_enabled.load()) {
            reply(s, "503 Service Unavailable", "text/plain",
                  "DynMap is turned off in the Mods menu.");
        } else if (path == "/favicon" || path == "/favicon.png" || path == "/favicon.ico") {
            reply(s, "200 OK", "image/png",
                  std::string(reinterpret_cast<const char*>(kFaviconPng), kFaviconPngSize),
                  true);
        } else if (path == "/api/state") {
            reply(s, "200 OK", "application/json", state_json());
        } else if (path == "/api/calib") {
            Calib c;
            if (query_double(query, "ax", &c.ax) && query_double(query, "bx", &c.bx) &&
                query_double(query, "az", &c.az) && query_double(query, "bz", &c.bz) &&
                c.ax != 0 && c.az != 0) {
                {
                    std::lock_guard<std::mutex> lock(g_mutex);
                    g_calib = c;
                }
                save_calib(c);
                logf("Calibration saved: x*%.6f%+.2f, z*%.6f%+.2f", c.ax, c.bx, c.az, c.bz);
                reply(s, "200 OK", "application/json", "{\"ok\":true}");
            } else {
                reply(s, "400 Bad Request", "application/json", "{\"ok\":false}");
            }
        } else if (!serve_file(s, path)) {
            reply(s, "404 Not Found", "text/plain", "Not found");
        }
    }
    shutdown(s, SD_BOTH);
    closesocket(s);
}

void server() {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        logf("WSAStartup failed.");
        return;
    }
    const int port = g_port.load();
    SOCKET ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(g_lan.load() ? INADDR_ANY : INADDR_LOOPBACK);
    addr.sin_port = htons(static_cast<u_short>(port));
    BOOL reuse = TRUE;
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<char*>(&reuse), sizeof(reuse));
    if (ls == INVALID_SOCKET ||
        bind(ls, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0 ||
        listen(ls, 32) != 0) {
        logf("Could not listen on port %d (error %d). Change Port in DynMap.ini.", port,
             WSAGetLastError());
        return;
    }
    logf("Map on http://localhost:%d/%s (web files: %s)", port,
         g_lan.load() ? " and http://<this PC's IP>:<port>/ on your network" : "",
         g_web_root.string().c_str());
    for (;;) {
        SOCKET c = accept(ls, nullptr, nullptr);
        if (c == INVALID_SOCKET) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
        }
        std::thread(handle_client, c).detach();
    }
}

void on_enabled_changed(void*, const char* key, int value) {
    if (!key || std::strcmp(key, kSettingKey) != 0) return;
    g_enabled.store(value != 0);
    WritePrivateProfileStringW(L"DynMap", L"Enabled", value ? L"1" : L"0", g_ini_path.c_str());
}

}  // namespace

FH2MOD_EXPORT int fh2mod_init(const FH2ModApi* api) {
    if (!api || api->api_version < 3 || !api->register_mod || !api->log) return 1;
    FH2ModInfo info{};
    info.size = sizeof(info);
    info.name = "DynMap";
    info.version = kVersion;
    info.platform_version = "2.8.0";
    info.github_repo = "suderek22/FH2_DynMap";
    info.check_updates = 1;
    info.description = "Live web map of Forza Horizon 2 (alpha: you, plus demo Drivatars).";
    g_api = api;
    g_mod = api->register_mod(&info);
    if (!g_mod) return 1;

    std::wstring path(32768, L'\0');
    const DWORD len = GetModuleFileNameW(reinterpret_cast<HMODULE>(&__ImageBase), path.data(),
                                         static_cast<DWORD>(path.size()));
    path.resize(len);
    const auto dir = std::filesystem::path(path).parent_path();
    g_ini_path = dir / L"DynMap.ini";
    g_web_root = dir / L"DynMap" / L"web";

    const bool enabled = GetPrivateProfileIntW(L"DynMap", L"Enabled", 1, g_ini_path.c_str()) != 0;
    int port = static_cast<int>(GetPrivateProfileIntW(L"DynMap", L"Port", 8090, g_ini_path.c_str()));
    if (port < 1024 || port > 65535) port = 8090;
    g_enabled.store(enabled);
    g_port.store(port);
    const bool lan = GetPrivateProfileIntW(L"DynMap", L"AllowLan", 1, g_ini_path.c_str()) != 0;
    g_lan.store(lan);
    {
        // Drivatars on the map are a demo of multi-player listing; 0 turns them off.
        const bool ai = GetPrivateProfileIntW(L"DynMap", L"ShowAI", 1, g_ini_path.c_str()) != 0;
        g_show_ai.store(ai);
        WritePrivateProfileStringW(L"DynMap", L"ShowAI", ai ? L"1" : L"0", g_ini_path.c_str());
    }
    WritePrivateProfileStringW(L"DynMap", L"AllowLan", lan ? L"1" : L"0", g_ini_path.c_str());
    {
        // Manual wristband tier (1-7, 0 = unknown/white) until automatic reading is implemented.
        int wb = (int)GetPrivateProfileIntW(L"DynMap", L"Wristband", 0, g_ini_path.c_str());
        g_wristband.store(wb < 0 || wb > 7 ? 0 : wb);
        wchar_t v[8];
        swprintf(v, 8, L"%d", g_wristband.load());
        WritePrivateProfileStringW(L"DynMap", L"Wristband", v, g_ini_path.c_str());
    }
    wchar_t name[64] = {};
    GetPrivateProfileStringW(L"DynMap", L"PlayerName", L"", name, 64, g_ini_path.c_str());
    // Not set (or the old "Host" default): use the Windows user name until the real gamertag can be read.
    if (!name[0] || wcscmp(name, L"Host") == 0) {
        if (!GetEnvironmentVariableW(L"USERNAME", name, 64)) wcscpy_s(name, L"Host");
    }
    {
        char utf8[200] = {};
        WideCharToMultiByte(CP_UTF8, 0, name, -1, utf8, sizeof(utf8) - 1, nullptr, nullptr);
        std::lock_guard<std::mutex> lock(g_mutex);
        g_player_name = utf8[0] ? utf8 : "Host";
        g_calib.ax = load_double(L"Ax", kDefAx);
        g_calib.bx = load_double(L"Bx", kDefBx);
        g_calib.az = load_double(L"Az", kDefAz);
        g_calib.bz = load_double(L"Bz", kDefBz);
        // 0.1.0-0.1.2 wrote an uncalibrated placeholder; replace it with the new default.
        if (g_calib.ax == 1 && g_calib.bx == 3584 && g_calib.az == 1 && g_calib.bz == 2048)
            g_calib = Calib{};
        if (g_calib.ax == 0) g_calib.ax = 1;
        if (g_calib.az == 0) g_calib.az = 1;
    }
    WritePrivateProfileStringW(L"DynMap", L"Enabled", enabled ? L"1" : L"0", g_ini_path.c_str());
    WritePrivateProfileStringW(L"DynMap", L"Port", std::to_wstring(port).c_str(), g_ini_path.c_str());
    WritePrivateProfileStringW(L"DynMap", L"PlayerName", name, g_ini_path.c_str());
    save_calib(g_calib);

    if (api->api_version >= 4 && api->add_setting) {
        FH2Setting setting{};
        setting.size = sizeof(setting);
        setting.key = kSettingKey;
        setting.label = "Live web map";
        setting.description = "Serve the live map on localhost (port set in DynMap.ini).";
        setting.value = enabled ? 1 : 0;
        setting.on_change = on_enabled_changed;
        if (!api->add_setting(g_mod, &setting)) logf("Could not add the option to the Mods menu.");
    }

    std::thread(install_hook).detach();
    std::thread(watchdog).detach();
    std::thread(server).detach();
    logf("%s registered", kVersion);
    return 0;
}


