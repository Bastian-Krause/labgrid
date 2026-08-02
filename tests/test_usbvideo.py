import pytest

from labgrid.binding import BindingState
from labgrid.resource.remote import NetworkUSBVideo
from labgrid.driver.usbvideodriver import USBVideoDriver


def test_usbvideo_create(target):
    r = NetworkUSBVideo(
        target,
        name=None,
        host="localhost",
        busnum=0,
        devnum=1,
        path="0:1",
        vendor_id=0x0,
        model_id=0x0,
    )
    d = USBVideoDriver(target, name=None)
    assert isinstance(d, USBVideoDriver)


def test_stream_deprecated_caps_hint_kwarg(target, mocker):
    NetworkUSBVideo(
        target,
        name=None,
        host="localhost",
        busnum=0,
        devnum=1,
        path="0:1",
        vendor_id=0x0,
        model_id=0x0,
    )
    d = USBVideoDriver(target, name=None)
    d.state = BindingState.active
    d.video = mocker.MagicMock(command_prefix=[], path="/dev/video0")
    d.select_caps = mocker.MagicMock(return_value="caps")
    d.get_pipeline = mocker.MagicMock(return_value="")
    mocker.patch("labgrid.driver.usbvideodriver.subprocess.Popen")

    with pytest.warns(DeprecationWarning,
                      match="'caps_hint' is deprecated, use 'quality_hint' instead"):
        d.stream(caps_hint="mid")
    d.select_caps.assert_called_once_with("mid")
