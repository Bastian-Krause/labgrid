import functools
import warnings


def renamed_kwargs(**renames):
    """
    Accept deprecated keyword argument names.

    Maps old keyword argument names to the current ones, emitting a DeprecationWarning. Used where a
    driver's parameter names diverged from the protocol it implements: the signature follows the
    protocol, while the old name keeps working for a deprecation cycle.

    Must be applied above the step decorator, which binds the arguments it is given against the
    wrapped signature.

    Args:
        **renames: mapping of deprecated keyword argument name to its current name
    """
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            for old, new in renames.items():
                if old not in kwargs:
                    continue
                if new in kwargs:
                    raise TypeError(f"{func.__name__}() got both {old!r} and {new!r}")
                warnings.warn(
                    f"{func.__name__}() argument {old!r} is deprecated, use {new!r} instead",
                    DeprecationWarning, stacklevel=2)
                kwargs[new] = kwargs.pop(old)
            return func(*args, **kwargs)

        return wrapper

    return decorator
