# RAUC bundle

`demo.raucb` is a signed, verity-format RAUC update bundle built by
[mini-yocto](https://github.com/bastian-krause/mini-yocto) (branch
`claude/labgrid-guest-image-swap-ekfvdq`). It carries a barebox image for the
guest's NOR bootloader slot, built with a bumped `BAREBOX_BUILDSYSTEM_VERSION`
so the banner visibly changes after installation.

The guest image ships RAUC, so at the Python REPL `rauc status` shows the slot
layout without a network. Full **HTTP streaming** — `rauc install …/demo.raucb`,
which pulls the bundle over HTTP range requests via NBD and writes the
bootloader slot — is wired in the browser and covered by
the demo's own pytest suite (`tests/m8-pytest.mjs`): the in-browser network
stack gives the guest connectivity, and the demo streams *this* bundle from labgrid's
own HTTP provider, faked to serve it over that stack (see
`demo/env.yaml`'s `HTTPProvider` and `runtime/js/browsernet.js`). It is also
verified natively under `qemu-system-arm`.

The page fetches this file at boot and `HTTPProviderDriver.stage()` serves it
back to the guest, so it does not have to be a public URL — but it is still
deployed with the guest images, so a real hardware run can stream it too.
