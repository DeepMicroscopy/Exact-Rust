#!/usr/bin/env python3
"""Writes what only the host can see into the status file the server reads for its system health check (the pulse icon for site admins):
the state of the RAID and, when `ipmitool` is there, the hottest temperature sensor (iLO/IPMI). Run it from root's cron every 5 minutes:

    */5 * * * * /opt/exact-rust/deploy/host-status.py /var/lib/exact-host-status/status.json

and give compose that folder (HOST_STATUS_DIR in exact.env). A file the host has not rewritten for 15 minutes is an alert of its own.

RAID controllers, first one found wins: HPE Smart Array (`ssacli`, formerly `hpssacli`), Broadcom/LSI MegaRAID (`storcli64`), Linux
software RAID (/proc/mdstat). The file's format, in case you write it from something else:
    {"raid": {"status": "ok|warning|critical|unknown", "detail": "text"}, "temperature_c": 41.5}      (both parts optional)
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

LEVELS = ["ok", "warning", "critical"]


def worse(a, b):
    return b if LEVELS.index(b) > LEVELS.index(a) else a


def run(*cmd):
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    return out.stdout + out.stderr


# --- HPE Smart Array ---------------------------------------------------------------------------------------------------------

SSA_CRITICAL = ("failed", "disabled", "missing", "not configured", "overheated", "unrecoverable")


def ssacli_level(state):
    s = state.strip().lower()
    if s == "ok":
        return "ok"
    return "critical" if any(w in s for w in SSA_CRITICAL) else "warning"  # Rebuilding, Recovering, Interim Recovery Mode, Predictive Failure, ...


def parse_ssacli(config, status=""):
    """`ssacli ctrl all show config` (logical and physical drives) and `ssacli ctrl all show status` (controller, cache, battery)."""
    level, parts = "ok", []
    for m in re.finditer(r"^\s*logicaldrive (\d+) \(([^,]+), (RAID [^,]+), ([^)]+)\)", config, re.M):
        parts.append(f"logical drive {m.group(1)} {m.group(3)} {m.group(2)}: {m.group(4)}")
        level = worse(level, ssacli_level(m.group(4)))
    pds = re.findall(r"^\s*physicaldrive (\S+) \(.*, ([^,)]+)\)", config, re.M)
    bad = [(bay, st) for bay, st in pds if ssacli_level(st) != "ok"]
    for bay, st in bad:
        parts.append(f"physical drive {bay}: {st}")
        level = worse(level, "warning" if ssacli_level(st) == "warning" else "critical")
    if pds:
        parts.append(f"{len(pds) - len(bad)} of {len(pds)} physical drives OK")
    for m in re.finditer(r"^\s*(Controller|Cache|Battery/Capacitor) Status: (.+)$", status, re.M):
        if ssacli_level(m.group(2)) != "ok":
            parts.append(f"{m.group(1).lower()} status: {m.group(2).strip()}")
            level = worse(level, "warning")
    if not re.search(r"logicaldrive", config):
        return "unknown", "ssacli lists no logical drive"
    return level, "; ".join(parts)


# --- MegaRAID ----------------------------------------------------------------------------------------------------------------

STORCLI = {"Optl": "ok", "Dgrd": "warning", "Pdgd": "warning", "Rec": "warning", "OfLn": "critical", "Offln": "critical"}


def parse_storcli(text):
    vds = json.loads(text)["Controllers"][0]["Response Data"]["Virtual Drives"]
    level, parts = "ok", []
    for vd in vds:
        state = vd.get("State", "?")
        parts.append(f"{vd.get('DG/VD', '?')} {vd.get('TYPE', '')} {vd.get('Size', '')} {state}".replace("  ", " "))
        level = worse(level, STORCLI.get(state, "warning"))
    return level, "; ".join(parts)


# --- Linux software RAID -----------------------------------------------------------------------------------------------------

def parse_mdstat(text):
    level, parts = "ok", []
    for m in re.finditer(r"^(md\d+) : (\S+) (\S+)(.*)\n\s+\d+ blocks.*\[(\d+)/(\d+)\] \[([U_]+)\]", text, re.M):
        name, state, kind, _, want, have, flags = m.groups()
        parts.append(f"{name} {kind} {flags}")
        if "_" in flags:
            level = worse(level, "critical" if int(have) == 0 else "warning")
    if not parts:
        return "unknown", "no md array found"
    return level, "; ".join(parts)


# --- temperature -------------------------------------------------------------------------------------------------------------

def parse_ipmi_temperatures(text):
    """`ipmitool sdr type Temperature`: `Inlet Ambient | 01h | ok | 7.1 | 22 degrees C`."""
    values = [float(m.group(1)) for m in re.finditer(r"\|\s*(-?\d+(?:\.\d+)?) degrees C", text)]
    return max(values) if values else None


# --- the file ----------------------------------------------------------------------------------------------------------------

def raid():
    try:
        for tool in ("ssacli", "hpssacli"):
            if shutil.which(tool):
                return parse_ssacli(run(tool, "ctrl", "all", "show", "config"), run(tool, "ctrl", "all", "show", "status"))
        for tool in ("storcli64", "storcli"):
            if shutil.which(tool):
                return parse_storcli(run(tool, "/c0/vall", "show", "J"))
        if os.path.exists("/proc/mdstat") and "md" in open("/proc/mdstat").read():
            return parse_mdstat(open("/proc/mdstat").read())
    except Exception as e:  # the controller tool failed: the server shows it as a warning, not as a healthy RAID
        return "warning", f"reading the RAID failed: {e}"
    return "unknown", "no RAID tool found on the host (ssacli, storcli64, /proc/mdstat)"


def main(out):
    level, detail = raid()
    status = {"raid": {"status": level, "detail": detail}}
    if shutil.which("ipmitool"):
        try:
            t = parse_ipmi_temperatures(run("ipmitool", "sdr", "type", "Temperature"))
            if t is not None:
                status["temperature_c"] = t
        except Exception:
            pass
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(out)), prefix=".status-")
    with os.fdopen(fd, "w") as f:
        json.dump(status, f)
    os.chmod(tmp, 0o644)
    os.replace(tmp, out)  # atomic: the server never reads half a file


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/var/lib/exact-host-status/status.json")
