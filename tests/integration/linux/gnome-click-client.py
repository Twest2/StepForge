#!/usr/bin/python3
"""Exercise actual native Wayland window clicks in an isolated Shell."""
import json
import os
import sys
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gio, GLib, Gtk

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
events = []
other_events = []
other_bus = Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
other_bus.signal_subscribe('org.gnome.Shell', 'org.stepforge.Capture1', 'Click',
    '/org/stepforge/Capture', None, Gio.DBusSignalFlags.NONE,
    lambda *_: other_events.append(True))
clicked = []
window = Gtk.Window(title='StepForge native Wayland test')
window.set_default_size(1000, 600)
window.maximize()
button = Gtk.Button(label='Native Wayland target')
button.connect('clicked', lambda *_: clicked.append(True))
window.set_child(button)
window.present()

def call(path, interface, method, params=None):
    return bus.call_sync('org.gnome.Shell', path, interface, method, params,
                         None, Gio.DBusCallFlags.NONE, 5000, None)

def event(_bus, _sender, _path, _interface, _name, params):
    events.append(json.loads(params.unpack()[0]))

bus.signal_subscribe('org.gnome.Shell', 'org.stepforge.Capture1', 'Click',
    '/org/stepforge/Capture', None, Gio.DBusSignalFlags.NONE, event)

def begin():
    try:
        call('/org/stepforge/Test', 'org.stepforge.Test', 'HideOverview')
        window.present()
        call('/org/stepforge/Capture', 'org.stepforge.Capture1', 'Start')
        try:
            other_bus.call_sync('org.gnome.Shell', '/org/stepforge/Capture', 'org.stepforge.Capture1',
                'Stop', None, None, Gio.DBusCallFlags.NONE, 3000, None)
            raise AssertionError('A different connection stopped the recording')
        except GLib.Error as error:
            assert 'NotOwner' in str(error), error
        for i in range(5):
            GLib.timeout_add(700 * (i + 1), click)
        GLib.timeout_add(4100, done)
    except Exception as error:
        print(error, file=sys.stderr)
        loop.quit()
    return GLib.SOURCE_REMOVE

def click():
    call('/org/stepforge/Test', 'org.stepforge.Test', 'Click', GLib.Variant('(ii)', [500, 350]))
    return GLib.SOURCE_REMOVE

def done():
    call('/org/stepforge/Capture', 'org.stepforge.Capture1', 'Stop')
    loop.quit()
    return GLib.SOURCE_REMOVE

GLib.timeout_add(3000, begin)
for move_at in (1500, 1800, 2100):
    GLib.timeout_add(move_at, lambda: (call('/org/stepforge/Test', 'org.stepforge.Test', 'Move',
        GLib.Variant('(ii)', [500, 350])), GLib.SOURCE_REMOVE)[1])
GLib.timeout_add_seconds(15, lambda: (loop.quit(), GLib.SOURCE_REMOVE)[1])
loop.run()
assert len(clicked) == 5, f'Native GTK client received {len(clicked)} of 5 clicks'
assert len(events) == 5, f'StepForge received {len(events)} of 5 clicks: {events}'
assert not other_events, 'Click signals leaked to another bus connection'
assert all(e['x'] == 500 and e['y'] == 350 and e['button'] == 1 for e in events), events
print('GNOME 50 native Wayland click integration: 5/5 clicks, exact sampled coordinates; GTK received all clicks.')
