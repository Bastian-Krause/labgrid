"""A labgrid test suite. Nothing in here is browser-specific -- the same file
runs against real hardware, given an env.yaml with the same drivers."""

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
