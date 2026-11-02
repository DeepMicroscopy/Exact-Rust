import importlib.util
import os

spec = importlib.util.spec_from_file_location("host_status", os.path.join(os.path.dirname(__file__), "..", "..", "deploy", "host-status.py"))
hs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hs)

# the layout of `ssacli ctrl all show config` of a Smart Array (from HPE's documentation; check against the real output)
CONFIG_OK = """
Smart Array P440ar in Slot 0 (Embedded)   (sn: PDNLH0ARH8Q1XK)

   Internal Drive Cage at Port 1I, Box 1, OK

   array A (SAS, Unused Space: 0  MB)

      logicaldrive 1 (3.3 TB, RAID 5, OK)

      physicaldrive 1I:1:1 (port 1I:box 1:bay 1, SAS HDD, 900.1 GB, OK)
      physicaldrive 1I:1:2 (port 1I:box 1:bay 2, SAS HDD, 900.1 GB, OK)
      physicaldrive 1I:1:3 (port 1I:box 1:bay 3, SAS HDD, 900.1 GB, OK)
      physicaldrive 1I:1:4 (port 1I:box 1:bay 4, SAS HDD, 900.1 GB, OK)
"""
STATUS_OK = "Smart Array P440ar in Slot 0 (Embedded)\n   Controller Status: OK\n   Cache Status: OK\n   Battery/Capacitor Status: OK\n"


def test_ssacli_healthy():
    level, detail = hs.parse_ssacli(CONFIG_OK, STATUS_OK)
    assert level == "ok" and "logical drive 1 RAID 5 3.3 TB: OK" in detail and "4 of 4 physical drives OK" in detail


def test_ssacli_degraded_and_failed():
    degraded = CONFIG_OK.replace("RAID 5, OK", "RAID 5, Interim Recovery Mode").replace("bay 3, SAS HDD, 900.1 GB, OK", "bay 3, SAS HDD, 900.1 GB, Failed")
    level, detail = hs.parse_ssacli(degraded, STATUS_OK)
    assert level == "critical" and "Interim Recovery Mode" in detail and "1I:1:3: Failed" in detail
    assert hs.parse_ssacli(CONFIG_OK.replace("RAID 5, OK", "RAID 5, Recovering"), STATUS_OK)[0] == "warning"
    assert hs.parse_ssacli(CONFIG_OK, STATUS_OK.replace("Cache Status: OK", "Cache Status: Temporarily Disabled"))[0] == "warning"
    assert hs.parse_ssacli("nothing", "")[0] == "unknown"


# the real output of the DL380 Gen9 (Smart Array P840): `sudo ssacli ctrl all show config` / `show status`
REAL_CONFIG = """
Smart Array P840 in Slot 1                (sn: PDNNF0ARH8X3DN)

   Internal Drive Cage at Port 1I, Box 1 (Index 0), OK

   Port Name: 1I

   Array A (SATA, Unused Space: 0  MB)

      logicaldrive 2 (72.76 TB, RAID 6, OK)

      physicaldrive 1I:1:4 (port 1I:box 1:bay 4, SATA HDD, 20 TB, OK)
      physicaldrive 1I:1:5 (port 1I:box 1:bay 5, SATA HDD, 20 TB, OK)
      physicaldrive 2I:2:1 (port 2I:box 2:bay 1, SATA HDD, 20 TB, OK)

   Unassigned

      physicaldrive 1I:1:2 (port 1I:box 1:bay 2, SATA SSD, 1 TB, OK)
"""
REAL_STATUS = "Smart Array P840 in Slot 1\n   Controller Status: OK\n   Cache Status: Permanently Disabled\n\n"


def test_the_real_controller_is_healthy_and_its_missing_cache_is_not_mentioned():
    level, detail = hs.parse_ssacli(REAL_CONFIG, REAL_STATUS)
    assert level == "ok"
    assert "logical drive 2 RAID 6 72.76 TB: OK" in detail and "4 of 4 physical drives OK" in detail and "cache" not in detail
    assert hs.parse_ssacli(REAL_CONFIG, REAL_STATUS.replace("Controller Status: OK", "Controller Status: Failed"))[0] == "critical"


def test_storcli_and_mdstat():
    assert hs.parse_storcli('{"Controllers":[{"Response Data":{"Virtual Drives":[{"DG/VD":"0/0","TYPE":"RAID6","State":"Dgrd","Size":"21 TB"}]}}]}')[0] == "warning"
    md = "md0 : active raid1 sdb1[1] sda1[0]\n      1000 blocks super 1.2 [2/1] [U_]\n"
    assert hs.parse_mdstat(md)[0] == "warning"
    assert hs.parse_mdstat(md.replace("[U_]", "[UU]").replace("[2/1]", "[2/2]"))[0] == "ok"


def test_ipmi_temperature():
    text = "Inlet Ambient    | 01h | ok  |  7.1 | 22 degrees C\nCPU 1            | 02h | ok  |  3.1 | 47 degrees C\nExhaust          | 03h | ns  |  7.1 | No Reading\n"
    assert hs.parse_ipmi_temperatures(text) == 47.0
    assert hs.parse_ipmi_temperatures("") is None
