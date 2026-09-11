"""A labgrid test suite. Nothing in here is browser-specific -- the same file
runs against real hardware, given an env.yaml with the same drivers."""

import datetime

import pytest


@pytest.fixture
def barebox(strategy):
    """The BareboxDriver, with the board driven to the barebox prompt."""
    strategy.transition("barebox")
    return strategy.barebox


@pytest.fixture
def shell(strategy):
    """The ShellDriver, with the board booted to a networked Linux shell.

    The strategy waits for eth0's DHCP lease on the way here, so a test that
    gets this fixture already has connectivity -- no polling of its own.
    """
    strategy.transition("shell")
    return strategy.shell


def test_barebox_reports_a_version(barebox):
    assert "barebox" in "\n".join(barebox.run_check("version")).lower()


def test_barebox_environment_is_unmodified(barebox):
    """The board boots with its factory barebox environment.

    barebox layers saved non-volatile variables on top of the read-only default
    environment compiled into the image; `nv` lists the ones in effect. On an
    unmodified board that is exactly the shipped default set -- nothing has been
    changed and `saveenv`'d over it.
    """
    nv = {line.split(":", 1)[0].strip() for line in barebox.run_check("nv") if ":" in line}
    assert nv == {"allow_color", "autoboot_timeout", "boot.default", "user"}, nv


def test_guest_clock_is_the_real_time(shell):
    """The guest's RTC works: it reports the real current wall clock.

    QEMU seeds the emulated RTC from the browser's clock (-rtc base=utc), which
    two certificate checks depend on being current -- the RAUC bundle signature
    and the in-browser proxy's freshly-minted MITM cert. Read the guest's time
    and compare it to the host's now(). The window is wide on purpose: emulated
    seconds tick slower than wall-clock ones, so the guest clock lags real time
    by however long the boot took -- what matters is that it is the real date,
    not 1970 or a pinned build time.
    """
    guest = int(shell.run_check("date -u +%s")[0])
    host = datetime.datetime.now(datetime.timezone.utc).timestamp()
    assert abs(host - guest) < 300, f"guest {guest} vs host {host:.0f}"


def test_rauc_streams_a_bundle_over_https(env, strategy, shell):
    """Install a RAUC update by streaming it over HTTPS -- from inside the browser.

    The in-browser network stack gives the guest connectivity: it brings up eth0
    over DHCP at boot (mini-yocto's inittab), and when the browser proxy's MITM CA
    is present its /etc/profile.d snippet exports http(s)_proxy at login -- so a
    bare `rauc install` streams the bundle, no manual proxy prefix. The bundle is
    pulled over HTTP range requests (it never lands on disk whole), verified, and
    written to the barebox bootloader slot. The same test runs unchanged against
    real hardware, where the HTTP provider is a real server and the guest uses its
    real network.
    """
    # Stage the bundle on the HTTP provider and learn the URL to stream it from.
    # This is labgrid's normal provider flow: stage() puts the file where the
    # guest can fetch it and returns the URL. In the browser the provider is
    # faked -- the page serves the bytes over the in-browser proxy (nothing
    # leaves the browser); on real hardware it is a genuine HTTP server. The
    # strategy activated the provider in the off state, so strategy.http is live.
    bundle = env.config.get_image_path("rauc_bundle")
    url = strategy.http.stage(bundle)

    # the shell fixture booted us to a networked shell; stream the update over
    # HTTPS via the in-browser proxy, which the guest picked up from
    # /etc/profile.d -- along with SSL_CERT_FILE pointing at the proxy's MITM CA,
    # so the TLS handshake is *verified*, no https_proxy= prefix and no
    # --tls-no-verify.
    out = shell.run_check(f"rauc install {url}", timeout=600)
    assert any("succeeded" in line.lower() for line in out), "\n".join(out)

    # the new bootloader is live only after a power cycle; boot the updated
    # barebox and read the buildsystem version it now reports
    strategy.transition("off")
    strategy.transition("barebox")
    version = [line.strip() for line in strategy.barebox.run_check("echo $global.buildsystem.version")]
    assert version == ["mini-yocto-1.0-update"], version
