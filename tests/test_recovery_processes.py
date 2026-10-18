"""Real local processes, disposable files, no Docker or production credentials."""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest

SOURCE = pathlib.Path(__file__).parents[1] / 'deploy/recovery.py'
spec = importlib.util.spec_from_file_location('recovery_process_tests', SOURCE)
jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jobs)


class ProcessLifetimeTests(unittest.TestCase):
    def child(self, root):
        return ('import pathlib,time; pathlib.Path(' + repr(str(root / 'ready')) + ').write_text("started"); '
                'time.sleep(1.3); pathlib.Path(' + repr(str(root / 'late-action')) + ').write_text("unsafe")')

    def test_timeout_kills_descendant_even_when_output_is_detached(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            parent = ('import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",' + repr(self.child(root)) +
                      '],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(10)')
            with self.assertRaises(subprocess.TimeoutExpired):
                jobs.bounded_run([sys.executable, '-c', parent], timeout=1)
            self.assertTrue((root / 'ready').exists(), 'descendant must actually start for this regression')
            time.sleep(.5)
            self.assertFalse((root / 'late-action').exists())

    def test_outer_timeout_cleans_up_nested_helper_group(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            parent = ('import importlib.util,sys; s=importlib.util.spec_from_file_location("nested",' + repr(str(SOURCE)) +
                      '); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); '
                      'm.bounded_run([sys.executable,"-c",' + repr(self.child(root)) + '],timeout=10)')
            with self.assertRaises(subprocess.TimeoutExpired):
                jobs.bounded_run([sys.executable, '-c', parent], timeout=1)
            self.assertTrue((root / 'ready').exists())
            time.sleep(.5)
            self.assertFalse((root / 'late-action').exists())

    def test_successful_parent_cannot_leave_background_descendant(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            parent = ('import pathlib,subprocess,sys,time; subprocess.Popen([sys.executable,"-c",' + repr(self.child(root)) +
                      '],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); '
                      '\nwhile not pathlib.Path(' + repr(str(root / 'ready')) + ').exists(): time.sleep(.01)\nprint("completed")')
            result = jobs.bounded_run([sys.executable, '-c', parent], timeout=5)
            self.assertEqual(0, result.returncode)
            self.assertEqual('completed\n', result.stdout)
            time.sleep(1.4)
            self.assertFalse((root / 'late-action').exists())
