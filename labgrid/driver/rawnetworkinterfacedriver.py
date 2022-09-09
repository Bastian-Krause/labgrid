# pylint: disable=no-member
import json
import os
import signal
import subprocess

import attr

from .common import Driver
from ..factory import target_factory
from ..step import step
from ..util import sshmanager
from ..util.helper import processwrapper
from ..util.managedfile import ManagedFile
from ..resource.remote import RemoteNetworkInterface


@target_factory.reg_driver
@attr.s(eq=False)
class RawNetworkInterfaceDriver(Driver):
    bindings = {
        "iface": {"NetworkInterface", "RemoteNetworkInterface", "USBNetworkInterface"},
    }

    def __attrs_post_init__(self):
        super().__attrs_post_init__()
        self.proc_pcap_map = {}

    def _get_wrapper_prefix(self):
        return self.iface.command_prefix + ["sudo", "labgrid-raw-interface"]

    def _remote_tmp_file_name(self):
        cmd = self.iface.command_prefix + ["mktemp", "--dry-run"]
        return processwrapper.check_output(cmd).strip().decode("utf-8")

    @Driver.check_active
    @step(args=["count"])
    def record(self, *, count=None):
        capture = self._remote_tmp_file_name()
        cmd = self._get_wrapper_prefix() + [
            self.iface.ifname,
            "tcpdump", capture]
        if count is not None:
            cmd.append(str(count))

        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.proc_pcap_map[proc] = capture
        return proc

    @Driver.check_active
    @step(args=["proc", "filename"])
    def get_record(self, proc, filename, *, timeout=None):
        assert proc in self.proc_pcap_map

        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.send_signal(signal.SIGINT)
            out, err = proc.communicate()

        assert proc.returncode == 0, f"tcpdump out={out} err={err}"

        if isinstance(self.iface, RemoteNetworkInterface):
            # TODO: remove remote capture afterwards
            sshmanager.get_file(self.iface.host, self.proc_pcap_map[proc], filename)
        else:
            os.rename(self.proc_pcap_map[proc], filename)
            os.sync()

    @Driver.check_active
    @step(args=["filename"])
    def start_replay(self, filename):
        mf = ManagedFile(filename, self.iface)
        mf.sync_to_resource()

        cmd = [self._get_wrapper_prefix() + [
            self.iface.ifname, "tcpreplay",
            mf.get_remote_path()]
        ]
        return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    @Driver.check_active
    @step()
    def get_statistics(self):
        cmd = [self.iface.command_prefix + [
            "ip",
            "--json",
            "-stats", "-stats",
            "link", "show",
            self.iface.ifname]
        ]
        output = processwrapper.check_output(cmd)
        return json.loads(output)[0]

    @Driver.check_active
    def get_address(self):
        return self.get_statistics()["address"]
