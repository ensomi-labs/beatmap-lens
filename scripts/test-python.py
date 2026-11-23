"""Run the colocated harness, Inspector service, pipeline, evaluation, and learning unit tests."""
from pathlib import Path
import sys
import unittest

repo = Path(__file__).resolve().parents[1]
areas = [
    area
    for area in (
        repo / 'harness',
        repo / 'apps' / 'inspector' / 'server',
        repo / 'apps' / 'inspector' / 'server' / 'tempo',
        *(repo / 'annotation' / name for name in ('pipeline', 'evaluation', 'learning', 'release')),
    )
    if (area / 'tests').is_dir()
]
sys.path[:0] = [str(repo / 'annotation'), *(str(area) for area in areas), *(str(area / 'tests') for area in areas)]
suite = unittest.TestSuite(unittest.TestLoader().discover(str(area / 'tests'), pattern='test_*.py') for area in areas)
result = unittest.TextTestRunner(verbosity=1).run(suite)
sys.exit(not result.wasSuccessful())
