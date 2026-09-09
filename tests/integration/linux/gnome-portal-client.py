#!/usr/bin/python3
"""Real GNOME portal + PipeWire + native clicks, only in the isolated test bus."""
import json
import os
import subprocess
import sys
import threading
import base64
import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Atspi', '2.0')
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Gio, GLib, Gtk, Atspi, GdkPixbuf

assert os.environ.get('STEPFORGE_ISOLATED_GNOME') == '1'
root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
frames = []
clicks = []
errors = []
window = Gtk.Window(title='StepForge portal integration target')
window.set_default_size(1000, 600)
window.maximize()
button = Gtk.Button(label='Before click 1')
button.connect('clicked', lambda *_: button.set_label('After click'))
window.set_child(button)
window.present()
helper = subprocess.Popen(['/usr/bin/python3', '-u', root + '/app/platform/linux/portal_capture.py'],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

def command(value):
    helper.stdin.write(json.dumps(value) + '\n')
    helper.stdin.flush()

def driver(method, params=None):
    return bus.call_sync('org.gnome.Shell', '/org/stepforge/Test', 'org.stepforge.Test',
        method, params, None, Gio.DBusCallFlags.NONE, 5000, None)

def click():
    driver('Click', GLib.Variant('(ii)', [500, 350]))
    return GLib.SOURCE_REMOVE

offset = 0
def receive(msg):
    global offset
    print('PORTAL TEST', {k: v for k, v in msg.items() if k != 'png'}, flush=True)
    if msg['type'] == 'ready':
        offset = msg['epochOffset']
        window.present()
        driver('HideOverview')
        GLib.timeout_add(500, lambda: (command({'type': 'arm'}), GLib.SOURCE_REMOVE)[1])
    elif msg['type'] == 'armed':
        for i in range(4):
            GLib.timeout_add((i + 1) * 300, click)
        # No damage/new screen buffers for several seconds: the next click
        # must still have a preceding observation of the static desktop.
        GLib.timeout_add(4500, click)
    elif msg['type'] == 'click':
        clicks.append(msg)
        command({'type': 'frame', 'id': len(clicks), 'point': {'x': msg['x'], 'y': msg['y']},
                 'at': msg['at'], 'strict': True, 'lead': 100})
    elif msg['type'] == 'frame':
        if msg.get('error'):
            errors.append(msg['error'])
            loop.quit()
            return GLib.SOURCE_REMOVE
        loader = GdkPixbuf.PixbufLoader.new_with_type('png')
        loader.write(base64.b64decode(msg['png']))
        loader.close()
        image = loader.get_pixbuf()
        assert image.get_width() == 1280 and image.get_height() == 720
        assert msg['at'] <= clicks[msg['id'] - 1]['at']
        frames.append(msg)
        if len(frames) == 5:
            loop.quit()
    elif msg['type'] == 'error':
        errors.append(msg['reason'])
        loop.quit()
    return GLib.SOURCE_REMOVE

def read():
    for line in helper.stdout:
        GLib.idle_add(receive, json.loads(line))

# Only the test bus is visible here. Inspect the actual GNOME picker through
# accessibility, choosing the test's sole virtual monitor and then Share.
def approve():
    if frames or clicks:
        return GLib.SOURCE_REMOVE
    try:
        desktop = Atspi.get_desktop(0)
        targets = []
        def walk(node, depth=0):
            if depth > 40:
                return
            if node.get_process_id() == os.getpid():
                return
            name = node.get_name() or ''
            role = node.get_role_name()
            if name:
                targets.append((node, name, role))
            for i in range(node.get_child_count()):
                walk(node.get_child_at_index(i), depth + 1)
        for index in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(index)
            if app.get_name() == 'xdg-desktop-portal-gnome':
                walk(app)
        for node, name, role in targets:
            if name in ('Share', 'Select', 'Unknown Display', 'Meta-0', 'Headless') or role == 'check box':
                action = node.get_action_iface()
                if action and action.get_n_actions():
                    action.do_action(0)
    except Exception as error:
        print('Picker inspection:', error, flush=True)
    return GLib.SOURCE_CONTINUE

threading.Thread(target=read, daemon=True).start()
Atspi.set_timeout(500, 500)
GLib.timeout_add(1500, lambda: (command({'type': 'start', 'sampleMs': 50}), GLib.SOURCE_REMOVE)[1])
GLib.timeout_add(1000, approve)
GLib.timeout_add_seconds(30, lambda: (loop.quit(), GLib.SOURCE_REMOVE)[1])
try:
    loop.run()
finally:
    helper.stdin.close()
    try:
        helper.wait(timeout=3)
    except subprocess.TimeoutExpired:
        helper.kill()
        helper.wait()
assert not errors, errors
assert len(frames) == 5, f'Only {len(frames)} of 5 PNG captures completed'
print('GNOME portal integration: five native clicks produced five valid 1280x720 pre-click PNG frames.')
