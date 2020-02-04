# pylint: disable=no-member
"""The SSHDriver uses SSH as a transport to implement CommandProtocol and FileTransferProtocol"""
import logging
import os
import shutil
import subprocess
import tempfile

import attr

from ..factory import target_factory
from ..protocol import CommandProtocol, FileTransferProtocol
from .commandmixin import CommandMixin
from .common import Driver
from ..step import step
from .exception import ExecutionError


@target_factory.reg_driver
@attr.s(eq=False)
class SSHDriver(CommandMixin, Driver, CommandProtocol, FileTransferProtocol):
    """SSHDriver - Driver to execute commands via SSH"""
    bindings = {"networkservice": "NetworkService", }
    priorities = {CommandProtocol: 10, FileTransferProtocol: 10}
    keyfile = attr.ib(default="", validator=attr.validators.instance_of(str))
    stderr_merge = attr.ib(default=False, validator=attr.validators.instance_of(bool))
    codec = attr.ib(default="utf-8", validator=attr.validators.instance_of(str))

    def __attrs_post_init__(self):
        super().__attrs_post_init__()
        self.logger = logging.getLogger("{}({})".format(self, self.target))
        self._keepalive = None

    def on_activate(self):
        self.ssh_prefix = ["-o", "LogLevel=ERROR"]
        if self.keyfile:
            keyfile_path = self.keyfile
            if self.target.env:
                keyfile_path = self.target.env.config.resolve_path(self.keyfile)
            self.ssh_prefix += ["-i", keyfile_path ]
        if not self.networkservice.password:
            self.ssh_prefix += ["-o", "PasswordAuthentication=no"]

        self.control = self._check_master()
        self.ssh_prefix += ["-F", "/dev/null"]
        if self.control:
            self.ssh_prefix += ["-o", "ControlPath={}".format(self.control)]

        self._keepalive = None
        self._start_keepalive();

    def on_deactivate(self):
        try:
            self._stop_keepalive()
        finally:
            self._cleanup_own_master()

    def _start_own_master(self):
        """Starts a controlmaster connection in a temporary directory."""
        self.tmpdir = tempfile.mkdtemp(prefix='labgrid-ssh-tmp-')
        control = os.path.join(
            self.tmpdir, 'control-{}'.format(self.networkservice.address)
        )
        # use sshpass if we have a password
        args = ["sshpass", "-e"] if self.networkservice.password else []
        args += ["ssh", "-f", *self.ssh_prefix, "-x", "-o", "ConnectTimeout=30",
                 "-o", "ControlPersist=300", "-o",
                 "UserKnownHostsFile=/dev/null", "-o", "StrictHostKeyChecking=no",
                 "-o", "ServerAliveInterval=15", "-MN", "-S", control, "-p",
                 str(self.networkservice.port), "{}@{}".format(
                     self.networkservice.username, self.networkservice.address)]

        env = os.environ.copy()
        if self.networkservice.password:
            env['SSHPASS'] = self.networkservice.password
        self.process = subprocess.Popen(args, env=env)

        try:
            if self.process.wait(timeout=30) != 0:
                raise ExecutionError(
                    "failed to connect to {} with {} and {}".
                    format(self.networkservice.address, args, self.process.wait())
                )
        except subprocess.TimeoutExpired:
            raise ExecutionError(
                "failed to connect to {} with {} and {}".
                format(self.networkservice.address, args, self.process.wait())
                )

        if not os.path.exists(control):
            raise ExecutionError(
                "no control socket to {}".format(self.networkservice.address)
            )

        self.logger.debug('Connected to %s', self.networkservice.address)

        return control

    def _check_master(self):
        args = [
            "ssh", "-O", "check", "{}@{}".format(
                self.networkservice.username, self.networkservice.address
            )
        ]
        check = subprocess.call(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        if check == 0:
            return ""

        return self._start_own_master()

    @Driver.check_active
    @step(args=['command'], result=True)
    def run(self, command: str, *, timeout: int = None):
        return self._run(command, timeout=timeout)

    def _run(self, command: str, *, timeout: int = None):
        """Execute `command` on the target.

        This method runs the specified `command` on its target.
        It uses the ssh shell command to run the command and parses the exitcode.
        command - command to be run on the target

        returns:
        (stdout, stderr, returncode)
        """
        if not self._check_keepalive():
            raise ExecutionError("Keepalive no longer running")

        complete_cmd = ["ssh", "-x", *self.ssh_prefix,
                        "-p", str(self.networkservice.port), "{}@{}".format(
                            self.networkservice.username, self.networkservice.address
                        )] + command.split(" ")
        self.logger.debug("Sending command: %s", complete_cmd)
        if self.stderr_merge:
            stderr_pipe = subprocess.STDOUT
        else:
            stderr_pipe = subprocess.PIPE
        try:
            sub = subprocess.Popen(
                complete_cmd, stdout=subprocess.PIPE, stderr=stderr_pipe
            )
        except:
            raise ExecutionError(
                "error executing command: {}".format(complete_cmd)
            )

        stdout, stderr = sub.communicate(timeout=timeout)
        stdout = stdout.decode(self.codec, self.decodeerrors).split('\n')
        stdout.pop()
        if stderr is None:
            stderr = []
        else:
            stderr = stderr.decode(self.codec, self.decodeerrors).split('\n')
            stderr.pop()
        return (stdout, stderr, sub.returncode)

    def get_status(self):
        """The SSHDriver is always connected, return 1"""
        return 1

    @Driver.check_active
    @step(args=['local_file', 'remote_file'])
    def put(self, local_file: str, remote_file: str = ''):
        transfer_cmd = [
            "scp",
            *self.ssh_prefix,
            "-P", str(self.networkservice.port),
            local_file,
            "{user}@{host}:{remotepath}".format(
                user=self.networkservice.username,
                host=self.networkservice.address,
                remotepath=remote_file)
            ]

        try:
            sub = subprocess.call(
                transfer_cmd
            )  #, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except:
            raise ExecutionError(
                "error executing command: {}".format(transfer_cmd)
            )
        if sub != 0:
            raise ExecutionError(
                "error executing command: {}".format(transfer_cmd)
            )

    @Driver.check_active
    @step(args=['remote_file', 'local_file'])
    def get(self, remote_file: str, local_file: str = "."):
        transfer_cmd = [
            "scp",
            *self.ssh_prefix,
            "-P", str(self.networkservice.port),
            "{user}@{host}:{filename}".format(
                user=self.networkservice.username,
                host=self.networkservice.address,
                filename=remote_file),
            local_file
            ]

        try:
            sub = subprocess.call(
                transfer_cmd
            )  #, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except:
            raise ExecutionError(
                "error executing command: {}".format(transfer_cmd)
            )
        if sub != 0:
            raise ExecutionError(
                "error executing command: {}".format(transfer_cmd)
            )

    def _cleanup_own_master(self):
        """Exit the controlmaster and delete the tmpdir"""
        complete_cmd = "ssh -x -o ControlPath={cpath} -O exit -p {port} {user}@{host}".format(
            cpath=self.control,
            port=self.networkservice.port,
            user=self.networkservice.username,
            host=self.networkservice.address
        ).split(' ')
        res = subprocess.call(
            complete_cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )

        if res != 0:
            self.logger.info("Socket already closed")
        shutil.rmtree(self.tmpdir)

    def _start_keepalive(self):
        """Starts a keepalive connection via the own or external master."""
        args = ["ssh", *self.ssh_prefix, "cat"]

        assert self._keepalive is None
        self._keepalive = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        self.logger.debug('Started keepalive for %s', self.networkservice.address)

    def _check_keepalive(self):
        return self._keepalive.poll() is None

    def _stop_keepalive(self):
        assert self._keepalive is not None

        self.logger.debug('Stopping keepalive for %s', self.networkservice.address)

        try:
            self._keepalive.communicate(timeout=60)
        except subprocess.TimeoutExpired:
            self._keepalive.kill()

        try:
            self._keepalive.wait(timeout=60)
        finally:
            self._keepalive = None
