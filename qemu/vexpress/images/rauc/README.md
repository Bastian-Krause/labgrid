# RAUC bundle

`demo.raucb` is a signed, verity-format RAUC update bundle built by
[mini-yocto](https://github.com/bastian-krause/mini-yocto) (branch
`claude/labgrid-guest-image-swap-ekfvdq`). It carries a barebox image for the
guest's NOR bootloader slot, built with a bumped `BAREBOX_BUILDSYSTEM_VERSION`
so the banner visibly changes after installation.

The guest image now ships RAUC, so at the Python REPL `rauc status` shows the
slot layout without a network. Full **HTTP streaming** — `rauc install
https://…/demo.raucb`, which pulls the bundle over HTTP range requests via NBD
and writes the bootloader slot — is verified natively under `qemu-system-arm`,
but is not yet wired in the browser: it needs a NIC on the emulated board (the
demo runs with `nic: none` to avoid a wasm indirect-call bug in QEMU's
default-NIC setup) and an in-browser network stack. Until then this bundle is
staged here, ready to be served over Pages for the guest to stream.
