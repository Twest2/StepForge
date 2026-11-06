#!/usr/bin/python3
"""The packaged mouse/touchpad udev rule, against real kernel input devices.

Run only as root on a disposable CI runner (see kde-integration.yml). It
installs the rule, creates virtual devices through /dev/uinput, and reads
the tags udev gave them:

* a plain mouse is tagged `uaccess` only while /usr/bin/kwin_wayland exists,
* a device that is also a keyboard is never tagged.
"""
import fcntl
import glob
import os
import shutil
import struct
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
RULE = os.path.join(ROOT, 'packaging/linux/common/60-stepforge-input.rules')
INSTALLED = '/etc/udev/rules.d/60-stepforge-input.rules'
KWIN = '/usr/bin/kwin_wayland'

UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502
UI_DEV_SETUP = 0x405C5503
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
EV_KEY, EV_REL = 1, 2
REL_X, REL_Y = 0, 1
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
# udev calls a device a keyboard when it has Esc, the digits and Q to D (codes 1-31).
KEYBOARD_KEYS = range(1, 60)


def fail(message):
    print(f'input-rule FAILED: {message}', file=sys.stderr)
    sys.exit(1)


def udev(*args):
    subprocess.run(['udevadm', *args], check=True)


class VirtualDevice:
    def __init__(self, name, keyboard=False):
        self.name = name
        self.fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_KEY)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_REL)
        for button in (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE):
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, button)
        for axis in (REL_X, REL_Y):
            fcntl.ioctl(self.fd, UI_SET_RELBIT, axis)
        if keyboard:
            for key in KEYBOARD_KEYS:
                fcntl.ioctl(self.fd, UI_SET_KEYBIT, key)
        setup = struct.pack('HHHH80sI', 0x03, 0x1234, 0x5678 + keyboard, 1, name.encode(), 0)
        fcntl.ioctl(self.fd, UI_DEV_SETUP, setup)
        fcntl.ioctl(self.fd, UI_DEV_CREATE)
        self.node = self.find_node()

    def find_node(self):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            for name_file in glob.glob('/sys/class/input/input*/name'):
                with open(name_file, encoding='utf-8') as handle:
                    if handle.read().strip() == self.name:
                        events = glob.glob(os.path.join(os.path.dirname(name_file), 'event*'))
                        if events:
                            return '/dev/input/' + os.path.basename(events[0])
            time.sleep(0.1)
        fail(f'no event node for {self.name} (is evdev loaded?)')

    def properties(self):
        udev('settle')
        out = subprocess.run(['udevadm', 'info', '--query=property', '--name', self.node],
                             check=True, capture_output=True, text=True).stdout
        return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)

    def tagged(self):
        props = self.properties()
        return 'uaccess' in props.get('CURRENT_TAGS', props.get('TAGS', '')).split(':')

    def close(self):
        fcntl.ioctl(self.fd, UI_DEV_DESTROY)
        os.close(self.fd)


def retrigger(*devices):
    for device in devices:
        udev('trigger', '--action=change', device.node)
    udev('settle')


def main():
    if os.geteuid() != 0 or os.environ.get('GITHUB_ACTIONS') != 'true':
        fail('run as root on a disposable CI runner only')
    if os.path.exists(KWIN):
        fail(f'{KWIN} already exists; this test needs a system without KDE first')
    subprocess.run(['modprobe', 'uinput'], check=False)
    shutil.copy(RULE, INSTALLED)
    udev('control', '--reload-rules')
    mouse = VirtualDevice('StepForge rule test mouse')
    combo = VirtualDevice('StepForge rule test keyboard', keyboard=True)
    try:
        props = mouse.properties()
        if props.get('ID_INPUT_MOUSE') != '1' or props.get('ID_INPUT_KEYBOARD') == '1':
            fail(f'udev did not classify the test mouse as a mouse only: {props}')
        if combo.properties().get('ID_INPUT_KEYBOARD') != '1':
            fail('udev did not classify the keyboard test device as a keyboard')

        if mouse.tagged() or combo.tagged():
            fail('the rule granted access without KDE Plasma installed')
        print('without KWin: no device tagged uaccess')

        with open(KWIN, 'w', encoding='utf-8') as handle:
            handle.write('#!/bin/sh\n')
        try:
            retrigger(mouse, combo)
            if not mouse.tagged():
                fail('the rule did not grant mouse access with KDE Plasma installed')
            if combo.tagged():
                fail('the rule granted access to a keyboard device')
            print('with KWin: the mouse is tagged uaccess, the keyboard device is not')
        finally:
            os.unlink(KWIN)
        retrigger(mouse, combo)
        if mouse.tagged():
            fail('the mouse kept its access after KDE Plasma was removed')
    finally:
        mouse.close()
        combo.close()
        os.unlink(INSTALLED)
        udev('control', '--reload-rules')
    print('input-rule: KDE-only, keyboard-free mouse access passed')


if __name__ == '__main__':
    main()
