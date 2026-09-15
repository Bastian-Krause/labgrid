"""An example labgrid test suite."""

import datetime
import os

import pytest


@pytest.fixture
def barebox(strategy):
    """Returns BareboxDriver with the board being in barebox state."""
    strategy.transition("barebox")
    return strategy.barebox


@pytest.fixture
def shell(strategy):
    """Returns ShellDriver with the board being in shell state."""
    strategy.transition("shell")
    return strategy.shell


@pytest.fixture
def ssh(strategy):
    """Returns SSHDriver with the board being in ssh state."""
    strategy.transition("ssh")
    return strategy.ssh


def test_barebox_dhcp(barebox):
    """Test that barebox can acquire a DHCP lease."""
    barebox.run_check("ifup -a")


def test_barebox_dmesg_has_no_warnings(barebox):
    """barebox logs nothing at warning level or above."""
    assert barebox.run_check("dmesg -p warn") == []


def test_guest_clock_is_the_real_time(shell):
    """The date/time in Linux are correct."""
    dut_time = int(shell.run_check("date -u +%s")[0])
    host_time = datetime.datetime.now(datetime.timezone.utc).timestamp()

    assert dut_time == pytest.approx(host_time, abs=300)


def test_linux_dmesg_has_no_unexpected_warnings(shell):
    """No kernel messages at warning level or above beyond a few benign ones.

    --level=warn+ is util-linux dmesg's "warning and higher" threshold, the same
    set barebox' `dmesg -p warn` reports. The emulated QEMU virt board logs a
    handful of unavoidable benign ones (the hrtimer figure varies with emulation
    speed, so match on its prefix); anything else is a real regression.
    """
    allowed = (
        "/cpus/cpu@0 missing clock-frequency property",
        "cacheinfo: Unable to detect cache hierarchy for CPU 0",
        "check access for rdinit=/init failed",
        "hrtimer: interrupt took",
    )
    warnings = shell.run_check("dmesg --level=warn+ --notime")
    for line in list(warnings):
        if line.startswith(allowed):
            warnings.remove(line)
    assert warnings == []


def test_ssh_runs_commands(ssh):
    """Commands run over the SSHDriver's connection reach the same target."""
    [uname] = ssh.run_check("uname -a")
    assert uname.startswith("Linux qemu-armv7a")


def test_ssh_file_round_trip(ssh, tmp_path):
    """A file survives put() to the target and get() back over scp."""
    payload = os.urandom(2048)
    (tmp_path / "out").write_bytes(payload)

    ssh.put(str(tmp_path / "out"), "/tmp/round-trip")
    ssh.get("/tmp/round-trip", str(tmp_path / "back"))

    assert (tmp_path / "back").read_bytes() == payload


def test_rauc_streams_a_bundle_over_https(env, strategy, shell):
    """Install a RAUC update by streaming it over HTTPS"""
    rauc_bundle = env.config.get_image_path("rauc_bundle")
    rauc_bundle_url = strategy.http.stage(rauc_bundle)

    shell.run_check(f"rauc install {rauc_bundle_url}", timeout=120)

    # transition to barebox and check for the new build system version
    strategy.transition("barebox")
    [barebox_buildsystem_version] = strategy.barebox.run_check("echo $global.buildsystem.version")
    assert barebox_buildsystem_version.strip().endswith("-update")
