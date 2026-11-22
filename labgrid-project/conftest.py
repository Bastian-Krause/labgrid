import os
import shlex

import __main__
import pytest
from labgrid.pytestplugin import hooks


def _live_environment(config_file, **kwargs):
    """Re-use live environment for demo purposes."""
    live_env = __main__.env

    if os.path.abspath(config_file) != os.path.abspath(live_env.config_file):
        raise pytest.UsageError(
            f"this page is running {live_env.config_file}; another environment cannot be built in the browser demo")

    # skip clean up
    live_env.cleanup = lambda: None

    return live_env


hooks.Environment = _live_environment


def pytest_report_header(config):
    """Return the full pytest command assembled from pytest.ini, PYTEST_ADDOPTS and CLI args."""
    argv = (list(config.getini("addopts"))
            + shlex.split(os.environ.get("PYTEST_ADDOPTS", ""))
            + list(config.invocation_params.args))
    return "invocation: pytest " + shlex.join(argv)
