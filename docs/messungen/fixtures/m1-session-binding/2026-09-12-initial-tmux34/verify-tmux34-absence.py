import json, os, sys
paths = [
    '/tmp/ab-m1-inventory-83adb3e7bddf4034b6d5b692f4a019f0',
    '/tmp/ab-m1-inventory-83adb3e7bddf4034b6d5b692f4a019f0/tmux.sock',
    '/proc/2681451', '/proc/2681457', '/proc/2681483',
    '/proc/2681491', '/proc/2681501', '/proc/2681509',
]
rows = [{'path': path, 'absent': not os.path.lexists(path)} for path in paths]
passed = all(row['absent'] for row in rows)
print(json.dumps({'kind': 'separate_session_binding_absence', 'paths': rows, 'all_absent': passed}, separators=(',', ':')), flush=True)
sys.exit(0 if passed else 1)
