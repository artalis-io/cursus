"""Check the image's real CLI using OTTO's pinned public fixtures and oracle."""
import copy
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, '/acceptance-otto')
from loading_reference import check_solution

source = Path('/acceptance-otto/test_loading_cli.py')
namespace = {'__file__': '/opt/otto/surge/tests/test_loading_cli.py', '__name__': 'otto_cli_contract'}
exec(compile(source.read_text(), str(source), 'exec'), namespace)
original_solve = namespace['solve']
validated = 0


def solve(model, valid=True):
    global validated
    result = original_solve(model, valid)
    if valid:
        check_solution(model, result)  # independent geometry and witness replay
        validated += 1
    return result


namespace['solve'] = solve
namespace['main']()  # HGS, stacking, no-stack, legacy, UNKNOWN, reloads, invalid JSON
for field, value in [('height_mm', 3000), ('weight_g', 100001)]:
    model = copy.deepcopy(namespace['fixture']())
    for request in model['loading']['requests']:
        request['units'][0][field] = value
    result = solve(model)
    assert result['stats']['unassigned'] == 2
    assert result['loading']['rounds'] == []
    assert len(result['loading']['unassigned_checks']) == 2
    assert all(row['infeasible_vehicles'] == 2 and row['unknown_vehicles'] == 0
               for row in result['loading']['unassigned_checks'])

print(json.dumps({'status': 'passed', 'native_solution_replays': validated,
    'invalid_inputs_rejected': namespace['INVALID_CASES'], 'impossible_height_and_payload': True,
    'surge_sha256': hashlib.sha256(Path('/opt/otto/surge/surge_solve').read_bytes()).hexdigest(),
    'contract_sha256': hashlib.sha256(source.read_bytes()).hexdigest()}))
