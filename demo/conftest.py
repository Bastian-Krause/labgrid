# What it takes to run labgrid's own pytest plugin against a target that is
# already up.
#
# The plugin itself is stock and fully loaded -- its fixtures, its --lg-* options,
# its markers, its verbosity handling. Only one thing cannot work as written:
# hooks.pytest_configure builds an Environment from --lg-env, and in this process
# that Environment already exists. Nor could a second one be built: constructing
# it re-executes the config's imports:, which re-runs @target_factory.reg_driver
# and raises RegistrationError, because labgrid's driver registry is global. That
# never bites a real run, where every pytest invocation is a fresh process; it
# always bites a prompt that outlives its runs.
#
# So Environment is redirected to the instance this page is driving, and its
# cleanup is disarmed, since the session outlives pytest here and cleanup()
# reaches QEMUDriver.on_deactivate() -- QMP "quit", and the prompt's objects with
# it. (sshmanager.close_all(), in the same teardown, has nothing to close.)

import os
import shlex

import __main__
import pytest
from labgrid.pytestplugin import hooks


def _environment(config_file, **kwargs):
    """The Environment for this config -- the one that is already running."""
    live = __main__.env
    if os.path.abspath(config_file) != os.path.abspath(live.config_file):
        raise pytest.UsageError(
            f"this page is running {live.config_file}; a second environment cannot "
            "be built in the browser, which has one QEMU and one already-negotiated "
            "QMP channel")
    live.cleanup = lambda: None
    return live


hooks.Environment = _environment


def pytest_report_header(config):
    # Spell out the command a shell would have been given: pytest reports the
    # rootdir and the config file it read, but never the options that came out
    # of it, so the short call at the prompt hides most of what is running.
    # Reassembled in pytest's own precedence order (Config.parse): pytest.ini,
    # then PYTEST_ADDOPTS, then the arguments actually passed in.
    argv = (list(config.getini("addopts"))
            + shlex.split(os.environ.get("PYTEST_ADDOPTS", ""))
            + list(config.invocation_params.args))
    return "invocation: pytest " + shlex.join(argv)
