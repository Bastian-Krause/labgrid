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

    Needs the in-browser network stack, so open the page with ?net=1. The guest
    brings up eth0 over DHCP at boot (mini-yocto's inittab), and when the browser
    proxy's MITM CA is present its /etc/profile.d snippet exports http(s)_proxy
    at login -- so a bare `rauc install` streams the bundle, no manual proxy
    prefix. The bundle is pulled over HTTP range requests (it never lands on disk
    whole), verified, and written to the barebox bootloader slot -- so the banner
    changes on the next boot. The same test runs unchanged against real hardware,
    where there is no proxy and the guest uses its real network.
    """
    # remember the running bootloader so we can prove the update took
    strategy.transition("barebox")
    before = "\n".join(strategy.barebox.run_check("version"))

    strategy.transition("shell")
    shell = strategy.shell
    # udhcpc ran at boot; the lease is already up. Networking is on by default,
    # so a missing lease is a real failure, not a reason to skip -- the whole
    # point of this test is to stream the bundle.
    addr = "\n".join(shell.run("ip -4 addr show eth0")[0])
    assert "inet " in addr, f"eth0 got no DHCP lease (is ?net=0 set?):\n{addr}"

    # the update: streamed over HTTPS via the in-browser proxy, which the guest
    # picked up from /etc/profile.d (no https_proxy= prefix needed). Its MITM
    # cert could be pinned with SSL_CERT_FILE=/run/wasmenv/proxy.crt; here we
    # skip verification with --tls-no-verify to keep the demo self-contained.
    out = shell.run_check(
        f"rauc install --tls-no-verify {RAUC_BUNDLE}",
        timeout=600,
    )
    assert any("succeeded" in line.lower() for line in out), "\n".join(out)

    # the new bootloader is live only after a power cycle
    strategy.transition("off")
    strategy.transition("barebox")
    after = "\n".join(strategy.barebox.run_check("version"))
    assert after != before, f"banner unchanged:\n{after}"
