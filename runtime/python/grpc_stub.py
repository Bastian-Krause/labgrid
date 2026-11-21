"""Stand-in for grpcio, placed into pyodide's site-packages as `grpc`.

grpcio is a C extension with no Emscripten build, and labgrid imports it at
module level: `import grpc` in labgrid/remote/{client,common}.py and in the
generated coordinator stubs, `from grpc.aio import ...` in
labgrid/remote/grpc/interceptor/client.py. Those modules are on the import path
of labgrid.pytestplugin, which this page loads for real -- so the imports have
to succeed even though nothing behind them can.

What those imports need, and all they need:

- attribute access on `grpc` and `grpc.aio`: annotations, default arguments,
  and `except grpc.aio.AioRpcError` clauses that are only evaluated once
  something is raised;
- `grpc.aio` importable as a module, for the `from grpc.aio import ...` form;
- the names it imports usable as *base classes*: the identity interceptors
  derive from ClientInterceptor together with UnaryUnaryClientInterceptor or
  StreamStreamClientInterceptor, so each name has to be a class of its own, or
  the class statement fails on an inconsistent MRO.

So every attribute is a distinct class, made on first access and cached, and
none of them can be instantiated. Touching one at runtime is what raises, which
is the honest outcome -- the coordinator this would talk to is unreachable from
a browser regardless. Dunders are not served: the import system probes
`__path__` to decide whether a module is a package, and an answer there would
have it treat this module as one.

Kept as grpc_stub.py in the tree and written out as grpc.py: a tracked
runtime/python/grpc.py would shadow the real grpc for anything run out of this
directory, gen_shims.py included.
"""

import sys
import types

_MESSAGE = ("grpc is unavailable in the browser: grpcio has no wasm build, and "
            "a labgrid coordinator is not reachable from a page")


class _Unavailable:
    """Base of every placeholder: constructing one is the first real use."""

    def __init__(self, *args, **kwargs):
        raise RuntimeError(_MESSAGE)


def _placeholder(module, name):
    return type(name, (_Unavailable,), {"__module__": module, "__qualname__": name})


class _Namespace(types.ModuleType):
    """A module whose every attribute is a placeholder class: grpc.aio."""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        cls = _placeholder(self.__name__, name)
        setattr(self, name, cls)
        return cls


# `from grpc.aio import X` imports the submodule first. Registering it here, as a
# side effect of importing grpc, is what lets that resolve without grpc being a
# package: the import system takes a module already in sys.modules as it is.
aio = _Namespace("grpc.aio")
sys.modules["grpc.aio"] = aio


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError(name)
    cls = _placeholder(__name__, name)
    globals()[name] = cls
    return cls
