import pexpect


class PtxExpect(pexpect.spawn):
    """labgrid Wrapper of the pexpect module.

    This class provides pexpect functionality for the ConsoleProtocol classes.
    driver: ConsoleProtocol object to be passed in
    """

    def __init__(self, driver, logfile=None, timeout=30, cwd=None):
        "Initializes a pexpect spawn instanse with required configuration"
        self.driver = driver
        self.logfile = logfile
        self.linesep = b"\n"
        pexpect.spawn.__init__(
            self,
            None,
            timeout=timeout,
            maxread=1,
            cwd=cwd,
            logfile=self.logfile,
        )

    def send(self, s):
        "Write to underlying transport, return number of bytes written"
        s = self._coerce_send_string(s)
        self._log(s, 'send')

        b = s
        return self.driver.write(b)

    def read_nonblocking(self, size=1, timeout=-1):
        "Pexpects needs a nonblocking read function, simply use pyserial with a timeout of 0"
        assert timeout is not None
        if timeout == -1:
            timeout = self.timeout
        return self.driver.read(size=size, timeout=timeout)
