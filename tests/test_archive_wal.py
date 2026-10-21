import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).parents[1]
SCRIPT = ROOT / 'deploy/postgres/archive-wal.sh'
SEGMENT = '000000010000000000000017'


def archive(src, name, directory):
    return subprocess.run(['sh', str(SCRIPT), str(src), name, str(directory)],
                          capture_output=True, text=True, timeout=30)


class ArchiveWalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temp.name)
        self.pg_wal = root / 'pg_wal'
        self.archive = root / 'archive'
        self.pg_wal.mkdir()
        self.archive.mkdir()
        self.src = self.pg_wal / SEGMENT
        self.src.write_bytes(os.urandom(64 * 1024))

    def tearDown(self):
        self.temp.cleanup()

    def leftovers(self):
        return [p.name for p in self.archive.iterdir() if p.name.startswith('.')]

    def test_new_segment_is_archived_completely(self):
        result = archive(self.src, SEGMENT, self.archive)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(self.src.read_bytes(), (self.archive / SEGMENT).read_bytes())
        self.assertEqual([], self.leftovers())

    def test_identical_existing_segment_is_success_without_rewriting(self):
        dest = self.archive / SEGMENT
        dest.write_bytes(self.src.read_bytes())
        os.utime(dest, (1_000_000_000, 1_000_000_000))
        inode = dest.stat().st_ino
        result = archive(self.src, SEGMENT, self.archive)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn('identical', result.stderr)
        self.assertEqual(inode, dest.stat().st_ino)
        self.assertEqual(1_000_000_000, int(dest.stat().st_mtime))
        self.assertEqual([], self.leftovers())

    def test_different_existing_segment_is_refused_and_kept(self):
        dest = self.archive / SEGMENT
        original = os.urandom(64 * 1024)
        dest.write_bytes(original)
        result = archive(self.src, SEGMENT, self.archive)
        self.assertNotEqual(0, result.returncode)
        self.assertIn('DIFFERENT', result.stderr)
        self.assertEqual(original, dest.read_bytes())
        self.assertEqual([], self.leftovers())

    def test_truncated_existing_segment_is_refused(self):
        # A partial file left by the old non-atomic command must not pass.
        dest = self.archive / SEGMENT
        dest.write_bytes(self.src.read_bytes()[:4096])
        result = archive(self.src, SEGMENT, self.archive)
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(4096, dest.stat().st_size)

    def test_repeated_archiving_is_idempotent(self):
        for _ in range(3):
            result = archive(self.src, SEGMENT, self.archive)
            self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(self.src.read_bytes(), (self.archive / SEGMENT).read_bytes())
        self.assertEqual([SEGMENT], sorted(p.name for p in self.archive.iterdir()))

    def test_unsafe_names_and_missing_source_are_refused(self):
        for name in ('', '../escape', '.hidden', 'a/b'):
            result = archive(self.src, name, self.archive)
            self.assertNotEqual(0, result.returncode, name)
        result = archive(self.pg_wal / 'absent', SEGMENT, self.archive)
        self.assertNotEqual(0, result.returncode)
        self.assertEqual([], list(self.archive.iterdir()))

    def test_unwritable_archive_fails_without_a_wal_named_file(self):
        if os.geteuid() == 0:
            self.skipTest('root ignores directory permissions')
        self.archive.chmod(0o500)
        try:
            result = archive(self.src, SEGMENT, self.archive)
            self.assertNotEqual(0, result.returncode)
            self.assertFalse((self.archive / SEGMENT).exists())
        finally:
            self.archive.chmod(0o700)


class ComposeUsesTheScript(unittest.TestCase):
    def test_both_databases_archive_through_the_script(self):
        text = (ROOT / 'compose.stateful.yaml').read_text()
        self.assertNotIn('test ! -f /backup/wal/%f && cp', text)
        self.assertEqual(2, text.count('archive_command=/opt/cursus/archive-wal.sh %p %f'))
        self.assertEqual(2, text.count('source: ./deploy/postgres/archive-wal.sh'))


if __name__ == '__main__':
    unittest.main()
