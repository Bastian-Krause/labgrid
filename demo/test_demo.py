"""A labgrid test suite. Nothing in here is browser-specific -- the same file
runs against real hardware, given an env.yaml with the same drivers."""

import pytest

from labgrid.driver import QEMUDriver


def test_target_has_a_qemu_driver(target):
    assert isinstance(target.get_driver(QEMUDriver, activate=False), QEMUDriver)


def test_barebox_reports_a_version(strategy):
    strategy.transition("barebox")
    assert "barebox" in "\n".join(strategy.barebox.run_check("version")).lower()


def test_linux_boots_to_a_shell(strategy):
    strategy.transition("shell")
    # the guest's tty ends its lines with CRLF, and labgrid splits on the LF
    assert [line.strip() for line in strategy.shell.run_check("uname -s")] == ["Linux"]


def test_rauc_streams_a_bundle_over_https(env, target, strategy):
    """Install a RAUC update by streaming it over HTTPS -- from inside the browser.

    Needs the in-browser network stack, so open the page with ?net=1. The guest
    brings up eth0 over DHCP at boot (mini-yocto's inittab), and when the browser
    proxy's MITM CA is present its /etc/profile.d snippet exports http(s)_proxy
    at login -- so a bare `rauc install` streams the bundle, no manual proxy
    prefix. The bundle is pulled over HTTP range requests (it never lands on disk
    whole), verified, and written to the barebox bootloader slot -- so the banner
    changes on the next boot. The same test runs unchanged against real hardware,
    where the HTTP provider is a real server and the guest uses its real network.
    """
    # Stage the bundle on the HTTP provider and learn the URL to stream it from.
    # This is labgrid's normal provider flow: stage() puts the file where the
    # guest can fetch it and returns the URL. In the browser the provider is
    # faked -- the page serves the bytes over the in-browser proxy (nothing
    # leaves the browser); on real hardware it is a genuine HTTP server. The
    # strategy activated the provider in the off state, so strategy.http is live.
    bundle = env.config.get_image_path("rauc_bundle")
    url = strategy.http.stage(bundle)

    # remember the running bootloader so we can prove the update took
    strategy.transition("barebox")
    before = "\n".join(strategy.barebox.run_check("version"))

    strategy.transition("shell")
    shell = strategy.shell
    # udhcpc ran at boot; the lease is already up. Ask labgrid's own ShellDriver
    # helpers rather than parsing `ip addr` by hand -- and go via the default
    # route's device, so this stays correct on real hardware where the interface
    # may not be eth0. Networking is on by default, so a missing lease is a real
    # failure, not a reason to skip: streaming the bundle is the whole point.
    iface = shell.get_default_interface_device_name()
    assert shell.get_ip_addresses(iface), f"{iface} got no DHCP lease (is ?net=0 set?)"

    # the update: streamed over HTTPS via the in-browser proxy, which the guest
    # picked up from /etc/profile.d -- along with SSL_CERT_FILE pointing at the
    # proxy's MITM CA, so the TLS handshake is *verified*, no https_proxy= prefix
    # and no --tls-no-verify. (The guest runs real browser time, -rtc base=utc,
    # which that freshly-minted MITM cert needs.)
    out = shell.run_check(f"rauc install {url}", timeout=600)
    assert any("succeeded" in line.lower() for line in out), "\n".join(out)

    # the new bootloader is live only after a power cycle
    strategy.transition("off")
    strategy.transition("barebox")
    after = "\n".join(strategy.barebox.run_check("version"))
    assert after != before, f"banner unchanged:\n{after}"
