"""
WhatsApp WuzAPI — Single-Window Launcher
Starts wuzapi, relay, and cloudflared together.
Run: python launcher.py
Configure: copy wuzapi.env.example to wuzapi.env and edit values.
Build exe: pip install pyinstaller && pyinstaller --onefile --name WhatsAppLauncher launcher.py
"""
import subprocess
import sys
import os
import time
import signal
import threading
import re
import shutil
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.system("")
C = {"R": "\033[91m", "G": "\033[92m", "Y": "\033[93m", "C": "\033[96m",
     "M": "\033[95m", "W": "\033[0m", "B": "\033[1m"}
def ts(): return datetime.now().strftime("%H:%M:%S")

def load_env(path):
    """Load KEY=VALUE pairs from a .env file (no external dependencies)."""
    config = {}
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                config[key.strip()] = value.strip().strip('"').strip("'")
    return config

def start_wuzapi():
    exe = os.path.join(BASE_DIR, "wuzapi.exe")
    if not os.path.exists(exe):
        print(f"{C['R']}[{ts()}] wuzapi.exe not found — download it from https://github.com/asternic/wuzapi/releases{C['W']}")
        return None

    # Load config from wuzapi.env (fall back to defaults)
    env_path = os.path.join(BASE_DIR, "wuzapi.env")
    cfg = load_env(env_path)

    port = cfg.get("WUZAPI_PORT", "8080")
    address = cfg.get("WUZAPI_ADDRESS", "0.0.0.0")
    admin_token = cfg.get("WUZAPI_ADMIN_TOKEN", "change-me")
    enc_key = cfg.get("WUZAPI_ENCRYPTION_KEY", "change-me-change-me-change-me12")
    hmac_key = cfg.get("WUZAPI_HMAC_KEY", "change-me-change-me-change-me-change-me12")
    webhook_url = cfg.get("WUZAPI_WEBHOOK_URL", "")

    if admin_token == "change-me":
        print(f"{C['Y']}[{ts()}] Warning: using default admin token. Copy wuzapi.env.example to wuzapi.env and set your own.{C['W']}")

    args = [exe, "-port", port, "-address", address,
            "-logtype", "console", "-color",
            "-admintoken", admin_token,
            "-globalencryptionkey", enc_key,
            "-globalhmackey", hmac_key]
    if webhook_url:
        args += ["-globalwebhook", webhook_url]

    logfile = open(os.path.join(BASE_DIR, "wuzapi.log"), "ab")
    return subprocess.Popen(
        args,
        stdout=logfile, stderr=logfile,
        stdin=subprocess.DEVNULL,
        cwd=BASE_DIR)

def start_relay():
    script = os.path.join(BASE_DIR, "relay.py")
    if not os.path.exists(script): return None
    return subprocess.Popen(
        [sys.executable, script],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        cwd=BASE_DIR)

def start_cloudflared():
    exe = os.path.join(BASE_DIR, "cloudflared.exe")
    if not os.path.exists(exe):
        print(f"{C['R']}[{ts()}] cloudflared.exe not found — download it from https://github.com/cloudflare/cloudflared/releases{C['W']}")
        return None
    return subprocess.Popen(
        [exe, "tunnel", "--url", "http://localhost:8080"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        cwd=BASE_DIR)

def stream_output(proc, label, color, logfile=None):
    try:
        src = open(logfile, "r", encoding="utf-8", errors="replace") if logfile else proc.stdout
        # If reading from file, seek to end first
        if logfile:
            src.seek(0, 2)
        while True:
            line = src.readline()
            if not line:
                import time; time.sleep(0.1)
                continue
            if isinstance(line, bytes):
                line = line.decode("utf-8", errors="replace")
            line = line.rstrip()
            if not line: continue
            match = re.search(r"(https://[a-z0-9-]+\.trycloudflare\.com)", line)
            if match:
                url = match.group(1)
                print(f"{color}[{label}]{C['W']} {C['B']}{C['G']}>>> {url} <<<{C['W']}")
                print(f"{C['Y']}[{ts()}] Auto-updating WUZAPI_URL and deploying Worker...{C['W']}")
                try:
                    import subprocess as sp
                    sp.run(
                        f'echo {url} | npx wrangler secret put WUZAPI_URL',
                        shell=True, text=True, capture_output=True,
                        cwd=BASE_DIR, timeout=30
                    )
                    sp.run(
                        "npm run deploy",
                        shell=True, capture_output=True, text=True,
                        cwd=BASE_DIR, timeout=60
                    )
                    print(f"{C['G']}[{ts()}] Worker deployed with new tunnel URL{C['W']}")
                except Exception as e:
                    print(f"{C['R']}[{ts()}] Auto-deploy failed: {e}. Run manually: wrangler secret put WUZAPI_URL && npm run deploy{C['W']}")
            else:
                print(f"{color}[{label}]{C['W']} {line}")
    except: pass

def main():
    print(f"\n{C['C']}{C['B']}  WhatsApp WuzAPI Launcher — wuzapi + relay + cloudflared{C['W']}\n")

    # On first run, copy .env.example → wuzapi.env if it doesn't exist
    env_path = os.path.join(BASE_DIR, "wuzapi.env")
    env_example = os.path.join(BASE_DIR, "wuzapi.env.example")
    if not os.path.exists(env_path) and os.path.exists(env_example):
        shutil.copy(env_example, env_path)
        print(f"{C['Y']}[{ts()}] Created wuzapi.env from wuzapi.env.example — edit it to set your own secrets{C['W']}")

    processes = {}

    print(f"{C['C']}[{ts()}] Starting wuzapi...{C['W']}")
    proc = start_wuzapi()
    if proc:
        processes["wuzapi"] = proc
        threading.Thread(target=stream_output, args=(proc, "API", C["C"], os.path.join(BASE_DIR, "wuzapi.log")), daemon=True).start()

    time.sleep(1.5)
    print(f"{C['M']}[{ts()}] Starting relay...{C['W']}")
    proc = start_relay()
    if proc:
        processes["relay"] = proc
        threading.Thread(target=stream_output, args=(proc, "RLY", C["M"]), daemon=True).start()

    time.sleep(1)
    print(f"{C['Y']}[{ts()}] Starting cloudflared...{C['W']}")
    proc = start_cloudflared()
    if proc:
        processes["tunnel"] = proc
        threading.Thread(target=stream_output, args=(proc, "TUN", C["Y"]), daemon=True).start()

    print(f"\n{C['G']}{C['B']}[{ts()}] All running. Ctrl+C to stop.{C['W']}\n")

    def shutdown(sig, frame):
        print(f"\n{C['Y']}[{ts()}] Stopping...{C['W']}")
        for n, p in processes.items():
            if p and p.poll() is None:
                p.terminate()
                try: p.wait(timeout=5)
                except: p.kill()
        print(f"{C['G']}[{ts()}] Done.{C['W']}")
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    while True:
        time.sleep(5)
        for name, proc in list(processes.items()):
            if proc and proc.poll() is not None:
                print(f"{C['R']}[{ts()}] {name} crashed, restarting...{C['W']}")
                if name == "wuzapi": processes[name] = start_wuzapi()
                elif name == "relay": processes[name] = start_relay()
                elif name == "tunnel": processes[name] = start_cloudflared()

if __name__ == "__main__":
    main()
