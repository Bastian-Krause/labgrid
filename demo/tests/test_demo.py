"""A labgrid test suite. Nothing in here is browser-specific -- the same file
runs against real hardware, given an env.yaml with the same drivers."""

import pytest

from labgrid.driver import QEMUDriver

# The demo's own RAUC update bundle, served next to this page on GitHub Pages.
RAUC_BUNDLE = "https://bastian-krause.github.io/labgrid/qemu/vexpress/images/rauc/demo.raucb"


def test_target_has_a_qemu_driver(target):
    assert isinstance(target.get_driver(QEMUDriver, activate=False), QEMUDriver)


def test_barebox_reports_a_version(strategy):
    strategy.transition("barebox")
    assert "barebox" in "\n".join(strategy.barebox.run_check("version")).lower()


def test_linux_boots_to_a_shell(strategy):
    strategy.transition("shell")
    # the guest's tty ends its lines with CRLF, and labgrid splits on the LF
    assert [line.strip() for line in strategy.shell.run_check("uname -s")] == ["Linux"]


def test_rauc_streams_a_bundle_over_https(strategy):
    """Install a RAUC update by streaming it over HTTPS -- from inside the browser.

    Needs the in-browser network stack, so open the page with ?net=1; without it
    the guest gets no DHCP lease and the test skips. The bundle is pulled over
    HTTP range requests through the browser's own proxy (it never lands on disk
    whole), verified, and written to the barebox bootloader slot -- so the
    banner changes on the next boot. The same test runs unchanged against real
    hardware with a real network.
    """
    # remember the running bootloader so we can prove the update took
    strategy.transition("barebox")
    before = "\n".join(strategy.barebox.run_check("version"))

    strategy.transition("shell")
    shell = strategy.shell
    shell.run("udhcpc -i eth0 -n -q")  # lease comes from the in-browser stack
    addr = "\n".join(shell.run("ip -4 addr show eth0")[0])
    # Networking is on by default, so a missing lease is a real failure, not a
    # reason to skip -- the whole point of this test is to stream the bundle.
    assert "inet " in addr, f"eth0 got no DHCP lease (is ?net=0 set?):\n{addr}"

    # the update: streamed over HTTPS via the browser proxy (192.168.127.253:80),
    # whose MITM certificate the guest could pin from the wasm0 mount
    # (mount -t 9p -o trans=virtio wasm0 /mnt; SSL_CERT_FILE=/mnt/proxy.crt) --
    # here we skip verification to keep the demo self-contained.
    out = shell.run_check(
        f"https_proxy=http://192.168.127.253:80 rauc install --tls-no-verify {RAUC_BUNDLE}",
        timeout=600,
    )
    assert any("succeeded" in line.lower() for line in out), "\n".join(out)

    # the new bootloader is live only after a power cycle
    strategy.transition("off")
    strategy.transition("barebox")
    after = "\n".join(strategy.barebox.run_check("version"))
    assert after != before, f"banner unchanged:\n{after}"
