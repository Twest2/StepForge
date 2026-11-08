"""Exercise the real portal request lifecycle with a deterministic D-Bus peer."""
import importlib.util
import pathlib
import sys
import types
import unittest

gi = types.ModuleType('gi')
gi.require_version = lambda *_: None
repository = types.ModuleType('gi.repository')
repository.Gio = types.SimpleNamespace(DBusSignalFlags=types.SimpleNamespace(NONE=0),
                                     DBusCallFlags=types.SimpleNamespace(NONE=0))
repository.GLib = types.SimpleNamespace(Error=RuntimeError, SOURCE_REMOVE=False,
                                      Variant=lambda _signature, args: args)
repository.Gst = repository.GstVideo = repository.GdkPixbuf = types.SimpleNamespace()
sys.modules['gi'] = gi
sys.modules['gi.repository'] = repository
source = pathlib.Path(__file__).resolve().parents[2] / 'app/platform/linux/portal_capture.py'
spec = importlib.util.spec_from_file_location('portal_capture', source)
portal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portal)


class RequestTests(unittest.TestCase):
    def run_request(self, mode, response=0, returned_path=None):
        capture = portal.Capture.__new__(portal.Capture)
        capture.closed = False
        capture.request_path = capture.request_loop = None
        state = types.SimpleNamespace(callback=None, timer=None, closed=[], removed=[], subscriptions={}, next_id=0)

        class Loop:
            def run(self):
                if mode == 'timeout':
                    state.timer()
                elif mode == 'closed':
                    capture.closed = True
                    capture.request_loop.quit()
                else:
                    value = types.SimpleNamespace(unpack=lambda: [response, {'session_handle': '/session/test'}])
                    state.callback(None, None, None, None, None, value)

            def quit(self):
                pass

        class Bus:
            def get_unique_name(self):
                return ':1.2'

            def signal_subscribe(self, *args):
                state.callback = args[-1]
                state.next_id += 1
                state.subscriptions[state.next_id] = args[3]
                return state.next_id

            def signal_unsubscribe(self, sub):
                del state.subscriptions[sub]

            def call_sync(self, _dest, path, _interface, method, *args):
                if method == 'Close':
                    state.closed.append(path)
                    return
                if mode == 'bus-error':
                    raise RuntimeError('org.freedesktop.DBus.Error.ServiceUnknown')
                return types.SimpleNamespace(unpack=lambda: [returned_path or capture.request_path])

        def add_timer(_seconds, callback):
            state.timer = callback
            return 42

        portal.GLib.MainLoop = Loop
        portal.GLib.timeout_add_seconds = add_timer
        portal.GLib.source_remove = state.removed.append
        capture.bus = Bus()
        try:
            result = capture.request('Start', '(osa{sv})', ['/session/test', '', {}])
            return result, state
        except portal.PortalError as error:
            return error, state
        finally:
            self.assertIsNone(capture.request_path)
            self.assertIsNone(capture.request_loop)
            self.assertEqual(state.subscriptions, {})

    def test_success(self):
        result, state = self.run_request('response')
        self.assertEqual(result, {'session_handle': '/session/test'})
        self.assertEqual(state.closed, [])
        self.assertEqual(state.removed, [42])

    def test_cancellation_is_distinct_from_failure(self):
        for response, expected in [(1, 'cancelled'), (2, 'portal-failed')]:
            result, _state = self.run_request('response', response)
            self.assertEqual(result.code, expected)
            self.assertEqual(result.stage, 'Start')

    def test_timeout_closes_request_without_removing_an_expired_timer(self):
        result, state = self.run_request('timeout')
        self.assertEqual(result.code, 'timeout')
        self.assertEqual(len(state.closed), 1)
        self.assertEqual(state.removed, [])

    def test_bus_failure_closes_request(self):
        result, state = self.run_request('bus-error')
        self.assertEqual(result.code, 'unavailable')
        self.assertEqual(len(state.closed), 1)

    def test_session_close_aborts_wait(self):
        result, state = self.run_request('closed')
        self.assertEqual(result.code, 'session-closed')
        self.assertEqual(len(state.closed), 1)

    def test_legacy_returned_handle_is_used_and_closed(self):
        result, state = self.run_request('timeout', returned_path='/request/legacy')
        self.assertEqual(result.code, 'timeout')
        self.assertEqual(state.closed, ['/request/legacy'])


if __name__ == '__main__':
    unittest.main()
