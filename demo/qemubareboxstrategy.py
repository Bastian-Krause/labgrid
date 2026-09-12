import enum
import time

import attr

from labgrid.factory import target_factory
from labgrid.step import step
from labgrid.strategy import Strategy, StrategyError, never_retry
from labgrid.util import Timeout


class Status(enum.Enum):
    unknown = 0
    off = 1
    barebox = 2
    shell = 3


@target_factory.reg_driver
@attr.s(eq=False)
class QEMUBareboxStrategy(Strategy):
    """QEMUBareboxStrategy - Strategy to switch QEMU to barebox or shell"""
    bindings = {
        "http": "HTTPProviderDriver",
        "qemu": "QEMUDriver",
        "barebox": "BareboxDriver",
        "shell": "ShellDriver",
    }

    status = attr.ib(default=Status.unknown)

    @never_retry
    @step(args=["status"])
    def transition(self, status, *, step):
        """Board state machine"""
        if not isinstance(status, Status):
            status = Status[status]

        if status == Status.unknown:
            raise StrategyError(f"can not transition to {status}")

        if status == self.status:
            step.skip("nothing to do")
            return

        if status == Status.off:
            self.target.deactivate(self.barebox)
            self.target.deactivate(self.shell)

            self.target.activate(self.http)
            self.target.activate(self.qemu)
            self.qemu.off()
        elif status == Status.barebox:
            self.transition(Status.off)
            # power on
            self.qemu.on()
            # interrupt barebox
            self.target.activate(self.barebox)
        elif status == Status.shell:
            # transition to barebox
            self.transition(Status.barebox)

            self.barebox.boot("")
            self.barebox.await_boot()
            self.target.activate(self.shell)

            # wait for DHCP lease
            timeout = Timeout(30.0)
            while not self.shell.get_ip_addresses("eth0"):
                if timeout.expired:
                    raise StrategyError(f"eth0 got no DHCP lease within {timeout.timeout} seconds")
                time.sleep(1)
        else:
            raise StrategyError(f"no transition found from {self.status} to {status}")

        self.status = status

    @never_retry
    @step(args=["status"])
    def force(self, status, *, step):
        """Force known board state."""
        if not isinstance(status, Status):
            status = Status[status]

        if status == Status.unknown:
            pass
        elif status == Status.off:
            self.target.activate(self.http)
            self.target.activate(self.qemu)
        elif status == Status.barebox:
            self.target.activate(self.http)
            self.target.activate(self.qemu)
            self.target.activate(self.barebox)
        elif status == Status.shell:
            self.target.activate(self.http)
            self.target.activate(self.qemu)
            self.target.activate(self.shell)
        else:
            raise StrategyError(f"can not force state {status}")

        self.status = status
