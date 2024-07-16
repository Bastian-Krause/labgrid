# pylint: disable=no-member
import contextlib
import json
import subprocess
import time

import attr

from .common import Driver
from ..factory import target_factory
from ..step import step
from ..util.helper import processwrapper
from ..util.managedfile import ManagedFile
from ..util.timeout import Timeout
from ..resource.common import NetworkResource


@target_factory.reg_driver
@attr.s(eq=False)
class RawNetworkInterfaceDriver(Driver):
    bindings = {
        "iface": {"NetworkInterface", "RemoteNetworkInterface", "USBNetworkInterface"},
    }

    def __attrs_post_init__(self):
        super().__attrs_post_init__()
        self._record_handle = None
        self._replay_handle = None

    def on_activate(self):
        self._set_interface("up")

    def on_deactivate(self):
        self._set_interface("down")

    def _wrap_command(self, args):
        wrapper = ["sudo", "labgrid-raw-interface"]

        if self.iface.command_prefix:
            # add ssh prefix, convert command passed via ssh (including wrapper) to single argument
            return self.iface.command_prefix + [" ".join(wrapper + args)]
        else:
            # keep wrapper and args as-is
            return wrapper + args

    def _stop(self, proc, *, timeout=None):
        assert proc is not None

        try:
            _, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.terminate()
            _, err = proc.communicate()
            raise

        if proc.returncode:
            raise subprocess.CalledProcessError(
                returncode=proc.returncode,
                cmd=proc.args,
                stderr=err,
            )

    @step()
    def _wait_for_interface_state(self, state, timeout=5.0):
        timeout = Timeout(timeout)

        while True:
            cmd = self.iface.command_prefix + [
                "cat",
                f"/sys/class/net/{self.iface.ifname}/operstate"]
            output = processwrapper.check_output(cmd).decode("ascii")
            if output.strip() == state:
                return
            if timeout.expired:
                raise TimeoutError(f"interface {self.iface.ifname} did not go {state} within {timeout.timeout} seconds")

            time.sleep(0.5)

    def wait_for_interface_state(self, state, timeout=3.0):
        self._wait_for_interface_state(state, timeout)

    @step(args=["state", "timeout"])
    def _set_interface(self, state, timeout=3.0):
        cmd = ["ip", self.iface.ifname, state]
        cmd = self._wrap_command(cmd)
        subprocess.check_call(cmd)

        self.wait_for_interface_state(state, timeout)

    @Driver.check_active
    def set_interface_up(self, timeout=3.0):
        """Set bound interface up."""
        self._set_interface("up", timeout)

    @Driver.check_active
    def set_interface_down(self, timeout=3.0):
        """Set bound interface down."""
        self._set_interface("down", timeout)

    @Driver.check_active
    def set_interface_link_mode(self, speed, duplex="full"):
        """Set fixed speed and duplex on interface."""
        cmd = ["ethtool", self.iface.ifname, "speed", speed]
        cmd = self._wrap_command(cmd)
        subprocess.check_call(cmd)

        cmd = ["ethtool", self.iface.ifname, "duplex", duplex]
        cmd = self._wrap_command(cmd)
        subprocess.check_call(cmd)

    @Driver.check_active
    @step(args=["filename", "count", "timeout"])
    def start_record(self, filename, *, count=None, timeout=None):
        """
        Starts tcpdump on bound network interface resource.

        Args:
            filename (str): name of a file to record to, or None to record to stdout
            count (int): optional, exit after receiving this many number of packets
            timeout (int): optional, number of seconds to capture packets before tcpdump exits
        Returns:
            Popen object of tcpdump process
        """
        assert self._record_handle is None

        cmd = ["tcpdump", self.iface.ifname]
        if count is not None:
            cmd.append(str(count))
        if timeout is not None:
            cmd.append("--timeout")
            cmd.append(str(timeout))
        cmd = self._wrap_command(cmd)
        if filename is None:
            self._record_handle = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        else:
            with open(filename, "wb") as outdata:
                self._record_handle = subprocess.Popen(cmd, stdout=outdata, stderr=subprocess.PIPE)
        return self._record_handle

    @Driver.check_active
    @step(args=["timeout"])
    def stop_record(self, *, timeout=None):
        """
        Stops previously started tcpdump on bound network interface resource.

        Args:
            timeout (int): optional, maximum number of seconds to wait for the tcpdump process to
                           terminate
        """
        try:
            self._stop(self._record_handle, timeout=timeout)
        except subprocess.TimeoutExpired:
            # If live streaming packets, there is no reason to wait for tcpdump
            # to finish, so expect a timeout if piping to stdout
            if self._record_handle.stdout is None:
                raise
        finally:
            self._record_handle = None

    @contextlib.contextmanager
    def record(self, filename, *, count=None, timeout=None):
        """
        Context manager to start/stop tcpdump on bound network interface resource.

        Either count or timeout must be specified.

        Args:
            filename (str): name of a file to record to, or None to live stream packets
            count (int): optional, exit after receiving this many number of packets
            timeout (int): optional, number of seconds to capture packets before tcpdump exits
        Returns:
            Popen object of tcpdump process. If filename is None, packets can be read from stdout
        """
        assert count or timeout

        try:
            yield self.start_record(filename, count=count, timeout=timeout)
        finally:
            self.stop_record(timeout=0 if filename is None else None)

    @Driver.check_active
    @step(args=["filename"])
    def start_replay(self, filename):
        """
        Starts tcpreplay on bound network interface resource.

        Args:
            filename (str): name of a file to replay from
        Returns:
            Popen object of tcpreplay process
        """
        assert self._replay_handle is None

        if isinstance(self.iface, NetworkResource):
            mf = ManagedFile(filename, self.iface)
            mf.sync_to_resource()
            cmd = self._wrap_command([f"tcpreplay {self.iface.ifname} < {mf.get_remote_path()}"])
            self._replay_handle = subprocess.Popen(cmd, stderr=subprocess.PIPE)
        else:
            cmd = self._wrap_command(["tcpreplay", self.iface.ifname])
            with open(filename, "rb") as indata:
                self._replay_handle = subprocess.Popen(cmd, stdin=indata)

        return self._replay_handle

    @Driver.check_active
    @step(args=["timeout"])
    def stop_replay(self, *, timeout=None):
        """
        Stops previously started tcpreplay on bound network interface resource.

        Args:
            timeout (int): optional, maximum number of seconds to wait for the tcpreplay process to
                           terminate
        """
        try:
            self._stop(self._replay_handle, timeout=timeout)
        finally:
            self._replay_handle = None

    @contextlib.contextmanager
    def replay(self, filename, *, timeout=None):
        """
        Context manager to start/stop tcpreplay on bound network interface resource.

        Args:
            filename (str): name of a file to replay from
            timeout (int): optional, maximum number of seconds to wait for the tcpreplay process to
                           terminate
        """
        try:
            yield self.start_replay(filename)
        finally:
            self.stop_replay(timeout=timeout)

    @Driver.check_active
    @step()
    def get_statistics(self):
        """
        Returns basic interface statistics of bound network interface resource.
        """
        cmd = self.iface.command_prefix + [
            "ip",
            "--json",
            "-stats", "-stats",
            "link", "show",
            self.iface.ifname]
        output = processwrapper.check_output(cmd)
        return json.loads(output)[0]

    @Driver.check_active
    def get_address(self):
        """
        Returns the MAC address of the bound network interface resource.
        """
        return self.get_statistics()["address"]

    @Driver.check_active
    def get_ethtool_settings(self):
        """
        Returns settings via ethtool of the bound network interface resource.
        """
        cmd = self.iface.command_prefix + [
            "ethtool",
            "--json",
            self.iface.ifname]
        output = subprocess.check_output(cmd, encoding="utf-8")
        return json.loads(output)[0]

    @Driver.check_active
    def get_ethtool_eee_settings(self):
        """
        Returns Energy-Efficient Ethernet settings via ethtool of the bound network interface
        resource.
        """
        cmd = self.iface.command_prefix + [
            "ethtool",
            "--show-eee",
            "--json",
            self.iface.ifname]
        output = subprocess.check_output(cmd, encoding="utf-8")
        return json.loads(output)[0]
