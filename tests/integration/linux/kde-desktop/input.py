#!/usr/bin/python3
"""Inject input only into the private KWin and optionally its synthetic mouse FD."""
import json
import os
import struct
import sys
import time
sys.path.insert(0, '/artifacts/generated')
from pywayland.client import Display
from fake_input import OrgKdeKwinFakeInput

display = Display()
display.connect()
registry = display.get_registry()
objects = {}
def global_added(registry, name, interface, version):
    if interface == OrgKdeKwinFakeInput.name:
        objects['input'] = registry.bind(name, OrgKdeKwinFakeInput, min(version, 6))
registry.dispatcher['global'] = global_added
display.roundtrip()
device = objects['input']
device.authenticate('StepForge isolated integration test', 'Test clicks in the disposable KDE desktop')
display.roundtrip()
mouse = os.open('/dev/input/event990', os.O_RDWR | os.O_NONBLOCK)
mirror = False
def event(code, state):
    if mirror:
        now = time.time()
        sec = int(now)
        usec = int((now - sec) * 1000000)
        os.write(mouse, struct.pack('llHHi', sec, usec, 1, code, state)
                 + struct.pack('llHHi', sec, usec, 0, 0, 0))
def button(code, state):
    event(code, state)
    device.button(code, state)
    display.roundtrip()
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    try:
        value = json.loads(line)
        action = value['action']
        if action == 'mirror':
            mirror = value['enabled']
        elif action == 'move':
            device.pointer_motion_absolute(value['x'], value['y'])
        elif action in ('click', 'press', 'release'):
            device.pointer_motion_absolute(value['x'], value['y'])
            display.roundtrip()
            time.sleep(0.03)
            code = value.get('button', 0x110)
            if action != 'release':
                button(code, 1)
            if action == 'click':
                time.sleep(0.03)
            if action != 'press':
                button(code, 0)
        elif action == 'key':
            for key in value.get('modifiers', []):
                device.keyboard_key(key, 1)
            device.keyboard_key(value['code'], 1)
            device.keyboard_key(value['code'], 0)
            for key in reversed(value.get('modifiers', [])):
                device.keyboard_key(key, 0)
        display.roundtrip()
        print(json.dumps({'ok': True}), flush=True)
    except Exception as error:
        print(json.dumps({'error': str(error)}), flush=True)
