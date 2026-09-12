"""An example labgrid test suite."""

import datetime

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


def test_barebox_dhcp(barebox):
    """Test that barebox can acquire a DHCP lease."""
    barebox.run_check("ifup -a")


def test_guest_clock_is_the_real_time(shell):
    """The date/time in Linux are correct."""
    dut_time = int(shell.run_check("date -u +%s")[0])
    host_time = datetime.datetime.now(datetime.timezone.utc).timestamp()

    assert dut_time == pytest.approx(host_time, abs=300)


def test_rauc_streams_a_bundle_over_https(env, strategy, shell):
    """Install a RAUC update by streaming it over HTTPS"""
    rauc_bundle = env.config.get_image_path("rauc_bundle")
    rauc_bundle_url = strategy.http.stage(rauc_bundle)

    shell.run_check(f"rauc install {rauc_bundle_url}", timeout=120)

    # transition to barebox and check for the new build system version
    strategy.transition("barebox")
    [barebox_buildsystem_version] = strategy.barebox.run_check("echo $global.buildsystem.version")
    assert barebox_buildsystem_version.strip().endswith("-update")
