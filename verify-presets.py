#!/usr/bin/env python3
"""
Verify every generated preset is structurally identical to the shipped `standard`
preset, ignoring only the persona text.

An agent preset's `plugins` list is complete, so a preset that silently lost a
tool row would strip that tool from every session using it — which is exactly the
bug that made workers unable to read files. This asserts the whole list: order,
ids, module names, `isolate` blocks, nested group config, and `!!js` conditions.

Exit code 0 = all identical. Run after generate-presets.py.
"""
import copy
import json
import sys

import yaml

STANDARD = '/opt/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'
OURS = 'cordis.patch.yml'


class Loader(yaml.SafeLoader):
    pass


# `!!js` is a DSH Loader tag. Keep the raw expression so it can be compared exactly.
Loader.add_constructor('tag:yaml.org,2002:js', lambda l, n: {'__js__': l.construct_scalar(n)})


def plugins_of(path, preset_id):
    doc = yaml.load(open(path), Loader=Loader)
    for entry in doc:
        if 'insert' not in entry:
            continue
        for row in entry['insert']:
            config = row.get('config') or {}
            if config.get('id') == preset_id:
                return config['plugins']
    raise SystemExit(f'preset "{preset_id}" not found in {path}')


def normalize(plugins):
    """Replace only the persona payload; keep every other byte comparable."""
    out = []
    for row in copy.deepcopy(plugins):
        if row.get('id') == 'persona':
            row['config'] = {'prefix': '<ROLE TEXT>', 'suffix': '<ROLE TEXT>'}
        out.append(row)
    return out


def main():
    if '--self-check' in sys.argv:
        return self_check()
    standard = normalize(plugins_of(STANDARD, 'standard'))
    doc = yaml.load(open(OURS), Loader=Loader)
    ours = []
    for entry in doc:
        if 'insert' not in entry:
            continue
        for row in entry['insert']:
            config = row.get('config') or {}
            if 'plugins' in config:
                ours.append((row['id'], config['id'], config['plugins']))

    if not ours:
        raise SystemExit('no presets found in cordis.patch.yml')

    failed = False
    for row_id, preset_id, plugins in ours:
        got = normalize(plugins)
        if len(got) != len(standard):
            print(f'  {preset_id:16} FAIL count {len(got)} != {len(standard)}')
            failed = True
            continue
        for index, (a, b) in enumerate(zip(standard, got)):
            if json.dumps(a, sort_keys=True) != json.dumps(b, sort_keys=True):
                print(f'  {preset_id:16} FAIL row {index} ({a.get("id")} vs {b.get("id")})')
                print(f'      standard: {json.dumps(a, sort_keys=True)[:220]}')
                print(f'      ours    : {json.dumps(b, sort_keys=True)[:220]}')
                failed = True
                break
        else:
            print(f'  {preset_id:16} OK  {len(got)}/{len(standard)} rows identical to standard')

    print()
    if failed:
        print('PARITY FAILED — a preset diverges from standard')
        return 1
    print(f'{len(ours)} preset(s) at full standard parity')
    return 0


def self_check():
    """Compare all presets within cordis.patch.yml to each other (no live
    install needed). Catches a preset silently losing a tool row — the exact
    bug that once left workers unable to read files."""
    doc = yaml.load(open(OURS), Loader=Loader)
    ours = []
    for entry in doc:
        if 'insert' not in entry:
            continue
        for row in entry['insert']:
            config = row.get('config') or {}
            if 'plugins' in config:
                ours.append((config['id'], normalize(config['plugins'])))
    if not ours:
        raise SystemExit('no presets found in cordis.patch.yml')
    ref_id, ref = ours[0]
    failed = False
    print(f'  {ref_id:16} REF   {len(ref)} rows')
    for preset_id, plugins in ours[1:]:
        if len(plugins) != len(ref):
            print(f'  {preset_id:16} FAIL count {len(plugins)} != {len(ref)}')
            failed = True
            continue
        for index, (a, b) in enumerate(zip(ref, plugins)):
            if json.dumps(a, sort_keys=True) != json.dumps(b, sort_keys=True):
                print(f'  {preset_id:16} FAIL row {index} ({a.get("id")} vs {b.get("id")})')
                failed = True
                break
        else:
            print(f'  {preset_id:16} OK   {len(plugins)}/{len(ref)} rows identical to {ref_id}')
    print()
    if failed:
        print('SELF-CHECK FAILED — presets diverge from each other')
        return 1
    print(f'{len(ours)} preset(s) mutually consistent')
    return 0


if __name__ == '__main__':
    sys.exit(main())
