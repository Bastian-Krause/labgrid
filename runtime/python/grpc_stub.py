"""Stand-in for grpcio, staged into pyodide's site-packages as `grpc`.

grpcio is a C extension with no Emscripten build, and labgrid imports it at
module level in labgrid/remote/{client,common}.py and in the generated
coordinator stubs. Those modules are on the import path of
labgrid.pytestplugin, which this page loads for real -- so the import has to
succeed even though nothing behind it can.

Nothing is *called* during import: the only references are annotations and
class bodies, which a permissive __getattr__ satisfies. Touching an attribute
at runtime is what raises, which is the honest outcome -- the coordinator this
would talk to is unreachable from a browser regardless.

Kept as grpc_stub.py in the tree and written out as grpc.py: a tracked
runtime/python/grpc.py would shadow the real grpc for anything run out of this
directory, gen_shims.py included.
"""


class _Unavailable:
    def __init__(self, *args, **kwargs):
        raise RuntimeError(
            "grpc is unavailable in the browser: grpcio has no wasm build, and "
            "a labgrid coordinator is not reachable from a page")


def __getattr__(name):
    return _Unavailable
