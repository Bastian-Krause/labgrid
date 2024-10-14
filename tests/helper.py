import shutil

import pexpect

def pexpect_spawn(*args, **kwargs):
    if shutil.which("coverage"):
        prefix = "coverage run --parallel-mode --data-file=.coverage"
        if args[0].contains(" "):
            cmd_executable, cmd_args = args[0].split(maxsplit=1)
            # convert to absolute path
            cmd_executable = shutil.which(cmd_executable)
            args[0] = f"{prefix} {cmd_executable}"

        args[0] = f"{prefix} {cmd_executable} {' '.join(cmd_args)}"

    pexpect.spawn(*args, **kwargs)
