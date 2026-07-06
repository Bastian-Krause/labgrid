from unittest.mock import Mock, patch

import pytest

from labgrid import Target
from labgrid.factory import target_factory
from labgrid.resource.remote import RemotePlace, RemotePlaceManager


def setup_manager_mock(resource_entries, remote_env=None):
    manager = RemotePlaceManager.get()
    manager.session = Mock()
    manager.loop = Mock()
    mock_place = Mock(name="test-place", tags={})
    mock_place.get_remote_env = Mock(return_value=remote_env or {})
    manager.session.get_place = Mock(return_value=mock_place)
    manager.session.get_target_resources = Mock(return_value=resource_entries)
    return manager


@pytest.fixture
def target():
    return Target("test-target")


@pytest.fixture(autouse=True)
def reset_manager():
    if RemotePlaceManager in RemotePlaceManager.instances:
        del RemotePlaceManager.instances[RemotePlaceManager]
    yield
    if RemotePlaceManager in RemotePlaceManager.instances:
        del RemotePlaceManager.instances[RemotePlaceManager]


def create_mock_resource_entry(cls, name, args):
    entry = Mock()
    entry.cls = cls
    entry.args = args
    entry.avail = True
    entry.extra = {}
    return entry


def test_expands_exported_resources(target):
    resource_entries = {
        ("netservice", "NetworkService"): create_mock_resource_entry(
            "NetworkService", "netservice", {"address": "localhost", "username": "test"}
        ),
        ("serialport", "NetworkSerialPort"): create_mock_resource_entry(
            "NetworkSerialPort", "serialport", {"host": "localhost", "port": 4000}
        ),
    }

    manager = setup_manager_mock(resource_entries)

    with patch.object(manager, '_start'):
        RemotePlace(target, "test-place")

    resource_classes = [r.__class__.__name__ for r in target.resources]
    assert "NetworkService" in resource_classes
    assert "NetworkSerialPort" in resource_classes


def test_expands_remote_env_by_default(target):
    remote_env = {
        "resources": {
            "NetworkService": {
                "address": "remote-host",
                "username": "remote-user",
            },
        },
        "drivers": {
            "SSHDriver": {},
        },
    }
    manager = setup_manager_mock({}, remote_env)

    with patch.object(manager, '_start'):
        RemotePlace(target, "test-place")

    assert [resource.__class__.__name__ for resource in target.resources] == [
        "RemotePlace",
        "NetworkService",
    ]
    assert [driver.__class__.__name__ for driver in target.drivers] == [
        "SSHDriver",
    ]


def test_local_env_overrides_remote_env_resources_and_drivers(target):
    remote_env = {
        "resources": [
            {"NetworkService": {
                "address": "remote-host",
                "username": "remote-user",
            }},
            {"NetworkSerialPort": {
                "host": "remote-host",
                "port": 4000,
            }},
            {"RemotePlace": {"name": "nested-place"}},
        ],
        "drivers": [
            {"SSHDriver": {"name": "remote-ssh"}},
            {"ManualSwitchDriver": {"name": "remote-switch"}},
        ],
    }
    manager = setup_manager_mock({}, remote_env)
    nested_place = Mock(name="nested-place", tags={})
    nested_place.get_remote_env.return_value = {}
    manager.session.get_place.side_effect = [
        manager.session.get_place.return_value,
        nested_place,
    ]

    with patch.object(manager, '_start'):
        RemotePlace(
            target,
            "test-place",
            ignore_resources=["NetworkService"],
            ignore_drivers=["SSHDriver"],
        )

    target_factory.make_resources_from_config(target, [{"NetworkService": {
        "address": "local-host",
        "username": "local-user",
    }}])
    target_factory.make_drivers_from_config(target, [{"SSHDriver": {"name": "local-ssh"}}])

    resource_classes = [resource.__class__.__name__ for resource in target.resources]
    driver_classes = [driver.__class__.__name__ for driver in target.drivers]
    assert resource_classes == ["RemotePlace", "NetworkSerialPort", "NetworkService"]
    assert driver_classes == ["ManualSwitchDriver", "SSHDriver"]
    assert [driver.name for driver in target.drivers] == ["remote-switch", "local-ssh"]
    assert target.get_resource("NetworkService").address == "local-host"
