#!/usr/bin/env python3
"""Audit this specification package, NOT the future application.

Usage: python tools/audit_spec.py --root . --output audit/package_audit.json
Stdlib does link/JSON/DAG/SQLite/business checks. jsonschema is optional;
missing jsonschema is reported as skipped, never a passed schema validation.
"""
from __future__ import annotations
import argparse
from pathlib import Path
import json, re, sqlite3, hashlib, sys, datetime, tempfile
from urllib.parse import unquote, urlparse

HAN = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff]')

def without_fences(text: str) -> str:
    output=[]; fence=None
    for line in text.splitlines():
        match=re.match(r'^\s*(`{3,}|~{3,})',line)
        if match:
            char=match.group(1)[0]
            if fence is None: fence=char
            elif fence==char: fence=None
            continue
        if fence is None: output.append(line)
    return '\n'.join(output)

def text_counts(root: Path) -> dict:
    records=[]
    for p in sorted(root.rglob('*.md')):
        # Audit reports and inventories do not count toward the promised text volume.
        rel=p.relative_to(root).as_posix()
        if rel.startswith('audit/') or rel in {'DELIVERY_AUDIT.md','FILE_INDEX.md'}: continue
        text=p.read_text(encoding='utf-8')
        records.append(dict(path=rel,bytes=len(text.encode()),han_all=len(HAN.findall(text)),
                            han_prose=len(HAN.findall(without_fences(text)))))
    return dict(markdown_count=len(records),han_all=sum(r['han_all'] for r in records),
                han_prose=sum(r['han_prose'] for r in records),
                markdown_bytes=sum(r['bytes'] for r in records),files=records)

class Audit:
    def __init__(self, root: Path): self.root=root; self.results=[]
    def record(self,name,status,detail=''): self.results.append(dict(name=name,status=status,detail=str(detail)))
    def check(self,name,action):
        try:
            result=action()
            if result is False: raise AssertionError('returned false')
            self.record(name,'passed',result if result is not None else '')
        except Exception as e: self.record(name,'failed',f'{type(e).__name__}: {e}')
    def load(self,path): return json.loads((self.root/path).read_text(encoding='utf-8'))
    def links(self):
        bad=[]; checked=0
        for p in self.root.rglob('*.md'):
            text=without_fences(p.read_text(encoding='utf-8'))
            for match in re.finditer(r'(?<!!)\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)',text):
                target=unquote(match.group(1)).strip('<>')
                if urlparse(target).scheme or target.startswith('#'): continue
                target=target.split('#',1)[0]
                if not target: continue
                checked+=1;dest=(p.parent/target).resolve()
                if not dest.is_relative_to(self.root) or not dest.exists(): bad.append(f'{p.relative_to(self.root)} -> {target}')
        assert not bad,'\n'.join(bad[:40])
        return f'{checked} relative file links resolve; URL fetch and heading anchors are outside this check'
    def dag(self):
        tasks=self.load('reference/contracts/tasks.json')['tasks'];by={t['id']:t for t in tasks}
        assert len(tasks)==84 and len(by)==84
        visiting=set();done=set()
        def visit(k):
            assert k in by,k
            if k in done:return
            assert k not in visiting,f'cycle at {k}'
            visiting.add(k)
            for d in by[k]['dependsOn']:visit(d)
            visiting.remove(k);done.add(k)
        for t in tasks:
            visit(t['id'])
            for key in ['specPath','casePath']:assert (self.root/t[key]).exists(),t[key]
            text=(self.root/t['specPath']).read_text();cases=(self.root/t['casePath']).read_text()
            assert len(t['ruleIds'])==6 and len(t['caseIds'])==6,t['id']
            for r in t['ruleIds']:assert r in text,r
            for c in t['caseIds']:assert c in cases,c
        return '84 unique tasks, acyclic dependencies, 504 rule IDs and 504 case IDs linked'
    def initial_progress(self):
        tasks=self.load('implementation/progress/tasks.initial.json')['tasks']
        assert len(tasks)==84 and all(t['status']=='not_started' for t in tasks)
        return 'No application task is falsely marked completed'
    def routes(self):
        eps=self.load('reference/contracts/api_registry.json')['endpoints']
        keys=[(e['method'],e['path']) for e in eps]
        assert len(keys)==len(set(keys))
        for e in eps:
            if e['path'] not in ['/api/health','/api/session']: assert e['security']!='none'
        return f'{len(eps)} unique method/path contracts; private routes guarded'
    def sql_tests(self):
        schema=(self.root/'reference/sql/001_initial.sql').read_text()
        db=sqlite3.connect(':memory:',isolation_level=None)
        db.execute('PRAGMA foreign_keys=ON')
        db.executescript(schema)
        def assert_rejected(sql,params=()):
            try:db.execute(sql,params)
            except sqlite3.IntegrityError:return
            raise AssertionError('Constraint accepted an invalid row')
        def add_item(k):
            db.execute('INSERT INTO knowledge_items(id,capture_request_id,capture_request_hash,captured_text,raw_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',(k,'cap-'+k,'0'*64,'中文 🧠\n原文','中文 🧠\n原文','2026-09-14T00:00:00Z','2026-09-14T00:00:00Z'))
        add_item('a');add_item('b')
        def add_run(k,state='running',kind='organize',subject='a'):
            db.execute('INSERT INTO ai_runs(id,request_key,request_hash,kind,subject_id,input_hash,state,config_revision,config_snapshot_json,prompt_version,started_at,deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                       (k,'key-'+k,'1'*64,kind,subject,'2'*64,state,1,'{}','organize-v1','2026-09-14T00:00:00Z','2026-09-14T00:03:00Z'))
        table_count=db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()[0]
        self.check('sql.nine_tables',lambda: table_count==9)
        self.check('sql.unicode_readback',lambda:db.execute('SELECT raw_text FROM knowledge_items WHERE id=?',('a',)).fetchone()[0]=='中文 🧠\n原文')
        self.check('sql.capture_unique',lambda:assert_rejected('INSERT INTO knowledge_items(id,capture_request_id,capture_request_hash,captured_text,raw_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',('dup','cap-a','0'*64,'x','x','t','t')))
        self.check('sql.item_type_enum',lambda:assert_rejected("UPDATE knowledge_items SET type='arbitrary' WHERE id='a'"))
        self.check('sql.raw_required',lambda:assert_rejected("UPDATE knowledge_items SET raw_text='' WHERE id='a'"))
        self.check('sql.importance_range',lambda:assert_rejected("UPDATE knowledge_items SET importance=99 WHERE id='a'"))
        self.check('sql.strict_integer',lambda:assert_rejected("UPDATE knowledge_items SET revision='text' WHERE id='a'"))
        db.execute("INSERT INTO tags VALUES ('tag','AI','ai','t')")
        db.execute("INSERT INTO item_tags VALUES ('a','tag',0)")
        self.check('sql.tag_normalized_unique',lambda:assert_rejected("INSERT INTO tags VALUES ('tag2','ai','ai','t')"))
        self.check('sql.item_tag_foreign_key',lambda:assert_rejected("INSERT INTO item_tags VALUES ('missing','tag',0)"))
        self.check('sql.tag_position_range',lambda:assert_rejected("UPDATE item_tags SET position=8 WHERE item_id='a'"))
        rsql='INSERT INTO relations(id,source_id,target_id,relation_type,origin,review_status,score,source_raw_version,target_raw_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
        self.check('sql.self_relation',lambda:assert_rejected(rsql,('r-self','a','a','related_to','ai','suggested',.8,1,1,'t','t')))
        self.check('sql.symmetric_order',lambda:assert_rejected(rsql,('r-sym','b','a','related_to','ai','suggested',.8,1,1,'t','t')))
        self.check('sql.manual_has_no_score',lambda:assert_rejected(rsql,('r-score','a','b','supports','manual','accepted',1.0,1,1,'t','t')))
        self.check('sql.manual_not_rejected',lambda:assert_rejected(rsql,('r-review','a','b','supports','manual','rejected',None,1,1,'t','t')))
        self.check('sql.ai_has_score',lambda:assert_rejected(rsql,('r-ai','a','b','supports','ai','suggested',None,1,1,'t','t')))
        db.execute(rsql,('r','a','b','related_to','ai','rejected',.8,1,1,'t','t'))
        self.check('sql.relation_unique_tombstone',lambda:assert_rejected(rsql,('r2','a','b','related_to','ai','suggested',.9,1,1,'t','t')))
        add_run('run1')
        def global_run_unique():
            try:add_run('run2',kind='flow',subject='b')
            except sqlite3.IntegrityError:return 'Second running operation of another kind rejected'
            raise AssertionError('global run slot not enforced')
        self.check('sql.global_run_singleton',global_run_unique)
        self.check('sql.attempt_cap',lambda:assert_rejected("UPDATE ai_runs SET attempt_count=3 WHERE id='run1'"))
        db.execute("UPDATE ai_runs SET state='succeeded' WHERE id='run1'")
        self.check('sql.run_slot_released',lambda:add_run('run3',kind='flow',subject='b'))
        def rollback():
            db.execute('BEGIN IMMEDIATE');add_item('rollback-item');db.execute('ROLLBACK')
            assert db.execute("SELECT COUNT(*) FROM knowledge_items WHERE id='rollback-item'").fetchone()[0]==0
        self.check('sql.transaction_rollback',rollback)
        def cas():
            cur=db.execute("UPDATE knowledge_items SET title='first',revision=revision+1 WHERE id='a' AND revision=1")
            assert cur.rowcount==1
            cur=db.execute("UPDATE knowledge_items SET title='second',revision=revision+1 WHERE id='a' AND revision=1")
            assert cur.rowcount==0
        self.check('sql.compare_and_swap',cas)
        db.execute("INSERT INTO views(id,name,kind,selection_json,renderer_version,prompt_version,created_at,updated_at) VALUES ('v','history','graph','{}','graph-v1',NULL,'t','t')")
        def cascade():
            db.execute("DELETE FROM knowledge_items WHERE id='a'")
            assert db.execute('SELECT COUNT(*) FROM relations').fetchone()[0]==0
            assert db.execute('SELECT COUNT(*) FROM item_tags').fetchone()[0]==0
            assert db.execute('SELECT COUNT(*) FROM views').fetchone()[0]==1
            assert db.execute('SELECT COUNT(*) FROM ai_runs').fetchone()[0]==2
        self.check('sql.delete_cascade_preserves_view_run',cascade)
        self.check('sql.foreign_key_check',lambda:db.execute('PRAGMA foreign_key_check').fetchall()==[])
        self.check('sql.integrity_check',lambda:db.execute('PRAGMA integrity_check').fetchone()[0]=='ok')
        db.close()
        return f'SQLite {sqlite3.sqlite_version}; in-memory reference schema tests only, not Node runtime'
    def model_schemas(self):
        try:import jsonschema
        except ImportError:
            self.record('schemas.jsonschema','skipped','Optional package jsonschema not installed');return
        for kind in ['organize','mindmap','flow']:
            schema=self.load(f'reference/schemas/{kind}.schema.json')
            validator=jsonschema.Draft202012Validator(schema,format_checker=jsonschema.FormatChecker())
            self.check(f'schema.{kind}.definition',lambda s=schema:jsonschema.Draft202012Validator.check_schema(s))
            self.check(f'schema.{kind}.valid_fixture',lambda k=kind,v=validator:v.validate(self.load(f'reference/contracts/example_{k}.json')))
        def rejects_extra():
            schema=self.load('reference/schemas/organize.schema.json');obj=self.load('reference/fixtures/organize_invalid_extra_field.json')
            errors=list(jsonschema.Draft202012Validator(schema).iter_errors(obj));assert errors
        self.check('schema.organize.rejects_extra_rawText',rejects_extra)
    def business_fixtures(self):
        allowed={i['id']:i for i in self.load('reference/fixtures/knowledge_samples.json')}
        def validate_tree(obj):
            nodes=obj['nodes'];by={n['id']:n for n in nodes}
            assert len(by)==len(nodes)
            roots=[n for n in nodes if n['parentId'] is None];assert len(roots)==1
            children={k:[] for k in by}
            for n in nodes:
                assert set(n['itemIds'])<=allowed.keys()
                if n['parentId'] is not None:
                    assert n['parentId'] in by and n['parentId']!=n['id'];children[n['parentId']].append(n['id'])
            seen=set();stack=set()
            def walk(k,depth):
                assert depth<=5 and k not in stack
                stack.add(k);seen.add(k)
                for child in children[k]:walk(child,depth+1)
                stack.remove(k)
            walk(roots[0]['id'],1);assert len(seen)==len(nodes)
        self.check('business.mindmap.valid_tree',lambda:validate_tree(self.load('reference/contracts/example_mindmap.json')))
        def cycle_rejected():
            try:validate_tree(self.load('reference/fixtures/mindmap_invalid_cycle.json'))
            except AssertionError:return
            raise AssertionError('invalid tree accepted')
        self.check('business.mindmap.rejects_cycle',cycle_rejected)
        def evidence_valid():
            obj=self.load('reference/contracts/example_organize.json')
            for r in obj['relations']:
                assert r['targetId'] in allowed
                for ev in r['evidence']:assert ev['quote'] in allowed[ev['itemId']]['rawText']
        self.check('business.organize.evidence_substrings',evidence_valid)
        def invalid_causal():
            obj=self.load('reference/fixtures/flow_invalid_causal.json')
            assert any(e['kind']=='causal' and not e['relationIds'] for e in obj['edges'])
            # Hard business gate: this fixture must be rejected despite passing shape schema.
            return 'Fixture violates causal evidence gate and is correctly identified as invalid'
        self.check('business.flow.causal_fixture_invalid',invalid_causal)
        def bundle_refs():
            b=self.load('reference/fixtures/backup_valid.json');assert b['schemaVersion']==1
            d=b['data'];items={i['id']:i for i in d['knowledgeItems']};tags={t['id']:t for t in d['tags']}
            assert len(items)==len(d['knowledgeItems']) and len(tags)==len(d['tags'])
            for it in d['itemTags']:assert it['itemId'] in items and it['tagId'] in tags
            for r in d['relations']:assert r['sourceId'] in items and r['targetId'] in items
            for v in d['views']:
                assert 'promptVersion' in v
                content=dict(kind=v['kind'],content=v['content'],sourceSnapshot=v['sourceSnapshot'],promptVersion=v['promptVersion'])
                h=hashlib.sha256(json.dumps(content,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
                assert h==v['contentHash']
            assert not ({'secrets','settings','ai_runs'} & d.keys())
            return f'{len(items)} items, {len(tags)} tags, references and view hash consistent'
        self.check('business.backup.references_hash_whitelist',bundle_refs)
    def backup_sql_roundtrip(self):
        bundle=self.load('reference/fixtures/backup_valid.json');data=bundle['data']
        db=sqlite3.connect(':memory:',isolation_level=None);db.row_factory=sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON');db.executescript((self.root/'reference/sql/001_initial.sql').read_text())
        db.execute("INSERT INTO settings(id,config_json,revision,updated_at) VALUES(1,'{}',1,'t')")
        db.execute("INSERT INTO secrets VALUES ('llm.api_key','TEST_SENTINEL_NOT_A_REAL_KEY','t')")
        enc=lambda x:json.dumps(x,ensure_ascii=False,separators=(',',':'))
        def insert_data(fail_at_relations=False):
            for i in data['knowledgeItems']:
                status='raw' if i['structuredBaseRawVersion'] is None else ('done' if i['structuredBaseRawVersion']==i['rawVersion'] else 'stale')
                mapping={'id':i['id'],'capture_request_id':i['captureRequestId'],'capture_request_hash':i['captureRequestHash'],
                         'captured_text':i['capturedText'],'raw_text':i['rawText'],'raw_version':i['rawVersion'],'revision':i['revision'],
                         'structured_base_raw_version':i['structuredBaseRawVersion'],'title':i['title'],'summary':i['summary'],'type':i['type'],
                         'keywords_json':enc(i['keywords']),'importance':i['importance'],'manual_fields_json':enc(i['manualFields']),
                         'status':status,'source_type':i['sourceType'],'source_ref':i['sourceRef'],'created_at':i['createdAt'],'updated_at':i['updatedAt']}
                db.execute('INSERT INTO knowledge_items('+','.join(mapping)+') VALUES('+','.join('?' for _ in mapping)+')',tuple(mapping.values()))
            for t in data['tags']:db.execute('INSERT INTO tags VALUES(?,?,?,?)',(t['id'],t['label'],t['normalized'],t['createdAt']))
            for t in data['itemTags']:db.execute('INSERT INTO item_tags VALUES(?,?,?)',(t['itemId'],t['tagId'],t['position']))
            if fail_at_relations:raise RuntimeError('INJECTED_RESTORE_FAILURE')
            for r in data['relations']:
                db.execute('INSERT INTO relations(id,source_id,target_id,relation_type,origin,review_status,score,reason,evidence_json,source_raw_version,target_raw_version,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (r['id'],r['sourceId'],r['targetId'],r['type'],r['origin'],r['reviewStatus'],r['score'],r['reason'],enc(r['evidence']),r['sourceRawVersion'],r['targetRawVersion'],r['revision'],r['createdAt'],r['updatedAt']))
            for v in data['views']:
                db.execute('INSERT INTO views(id,name,kind,selection_json,source_snapshot_json,content_json,content_hash,renderer_version,prompt_version,revision,generated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (v['id'],v['name'],v['kind'],enc(v['selection']),enc(v['sourceSnapshot']),enc(v['content']),v['contentHash'],v['rendererVersion'],v['promptVersion'],v['revision'],v['generatedAt'],v['createdAt'],v['updatedAt']))
        def failure_rolls_back():
            db.execute('BEGIN IMMEDIATE')
            try:insert_data(True)
            except RuntimeError:db.execute('ROLLBACK')
            for table in ['knowledge_items','tags','item_tags','relations','views']:
                assert db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]==0
            assert db.execute('SELECT value FROM secrets').fetchone()[0]=='TEST_SENTINEL_NOT_A_REAL_KEY'
        self.check('backup.sql_midway_rollback_preserves_settings',failure_rolls_back)
        db.execute('BEGIN IMMEDIATE');insert_data();db.execute('COMMIT')
        def values_preserved():
            for item in data['knowledgeItems']:
                row=db.execute('SELECT * FROM knowledge_items WHERE id=?',(item['id'],)).fetchone()
                assert row['captured_text']==item['capturedText'] and row['raw_text']==item['rawText']
                assert row['capture_request_hash']==item['captureRequestHash'] and row['revision']==item['revision']
                assert json.loads(row['manual_fields_json'])==item['manualFields']
                assert row['last_run_id'] is None
            edited=db.execute('SELECT * FROM knowledge_items WHERE id=?',(data['knowledgeItems'][1]['id'],)).fetchone()
            assert edited['status']=='stale' and edited['captured_text']!=edited['raw_text']
            return 'Original/current text, manual lock, capture fingerprint, versions and stale status preserved'
        self.check('backup.sql_restore_values',values_preserved)
        def view_preserved():
            row=db.execute('SELECT * FROM views').fetchone();v=data['views'][0]
            assert json.loads(row['content_json'])==v['content'] and row['prompt_version']==v['promptVersion']
            assert row['run_id'] is None and row['content_hash']==v['contentHash']
            assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
        self.check('backup.sql_view_prompt_hash_references',view_preserved)
        db.close()
        return 'Reference restoration executed against SQLite; future app import API is not thereby tested'

    def json_files(self):
        n=0
        for p in self.root.rglob('*.json'):
            # An existing report is not source input for its own audit.
            if 'audit' in p.relative_to(self.root).parts: continue
            json.loads(p.read_text());n+=1
        return f'{n} JSON files parse'
    def no_runtime_payload(self):
        bad=[]
        for p in self.root.rglob('*'):
            if not p.is_file():continue
            if p.suffix in ['.db','.sqlite','.sqlite3','.pem','.key'] or 'node_modules' in p.parts or '.env'==p.name:bad.append(p.relative_to(self.root).as_posix())
        assert not bad,bad
        return 'No database, node_modules, .env, or credential file is packaged; this is not a universal secret scanner'
    def run(self):
        for name,fn in [('links.relative_paths',self.links),('tasks.dag_and_ids',self.dag),('tasks.initial_status',self.initial_progress),('http.registry',self.routes),('files.json_parse',self.json_files),('files.no_runtime_payload',self.no_runtime_payload)]:self.check(name,fn)
        self.check('sql.reference_suite',self.sql_tests)
        self.model_schemas();self.business_fixtures()
        self.check('backup.reference_roundtrip_suite',self.backup_sql_roundtrip)
        counts=text_counts(self.root)
        self.check('volume.prose_han_at_least_200000',lambda:counts['han_prose']>=200000)
        summary={s:sum(r['status']==s for r in self.results) for s in ['passed','failed','skipped']}
        return dict(scope='Specification package only; application, Node24 runtime, browser and live LLM not tested',
                    auditedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    python=sys.version.split()[0],sqlite=sqlite3.sqlite_version,
                    summary=summary,counts=counts,checks=self.results)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',default=str(Path(__file__).resolve().parents[1]));parser.add_argument('--output',default='audit/package_audit.json');args=parser.parse_args()
    root=Path(args.root).resolve();report=Audit(root).run();dest=root/args.output;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(dict(summary=report['summary'],markdown=report['counts']['markdown_count'],han_prose=report['counts']['han_prose'],han_all=report['counts']['han_all']),ensure_ascii=False))
    for r in report['checks']:
        if r['status']!='passed':print(r['status'],r['name'],r['detail'])
    return 1 if report['summary']['failed'] else 0
if __name__=='__main__':raise SystemExit(main())
