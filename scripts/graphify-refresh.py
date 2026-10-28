"""Refresh graphify-out/ after code changes without losing the full rebuild's doc work.

`graphify update .` re-adds stale per-heading doc nodes and unnames communities
(see CLAUDE.md "Knowledge Graph"). This instead combines a fresh AST extraction
of the code with the committed graph's doc nodes, drops nodes whose source file
is gone or no longer scanned (.gitignore / .graphifyignore), rewrites the manifest
from the scan, and carries each community's name across by node overlap.

Run from the repo root:
    $(cat graphify-out/.graphify_python) scripts/graphify-refresh.py
"""
import json,subprocess,collections,sys
from pathlib import Path
def main():
    from graphify.detect import detect, save_manifest
    from graphify.extract import collect_files, extract
    from graphify.build import build_from_json
    from graphify.cluster import cluster, score_all
    from graphify.analyze import god_nodes, surprising_connections, suggest_questions
    from graphify.report import generate
    from graphify.export import to_json
    det=detect(Path('.'))
    cf=[]
    for f in det['files']['code']: cf.extend(collect_files(Path(f)) if Path(f).is_dir() else [Path(f)])
    ast=extract(cf,cache_root=Path('.'))
    print('AST',len(ast['nodes']),len(ast['edges']))
    old=json.load(open('graphify-out/graph.json'))
    EL='links' if 'links' in old else 'edges'
    print('old',len(old['nodes']),len(old[EL]),'keys',list(old.keys()))
    codeset={str(Path(f).resolve()) for f in cf}
    root=str(Path('.').resolve())+'/'
    def iscode(sf):
        if not sf: return False
        p=sf if sf.startswith('/') else root+sf
        return p in codeset
    astids={n['id'] for n in ast['nodes']}
    scanned=set()
    for fs in det['files'].values():
        for f in fs:
            p=Path(f)
            scanned|={str(x.resolve()) for x in collect_files(p)} if p.is_dir() else {str(p.resolve())}
    # Gone from disk, or present but excluded by .gitignore/.graphifyignore (graphify merges
    # both into its scan): either way the file is outside the corpus and its old nodes go.
    excluded=lambda sf: bool(sf) and (sf if sf.startswith('/') else root+sf) not in scanned
    semn=[n for n in old['nodes'] if n['id'] not in astids and not iscode(n.get('source_file')) and not excluded(n.get('source_file'))]
    allids=astids|{n['id'] for n in semn}
    seme=[e for e in old[EL] if not iscode(e.get('source_file')) and not excluded(e.get('source_file')) and e['source'] in allids and e['target'] in allids]
    print('sem nodes',len(semn),'sem edges',len(seme))
    semh=old.get('hyperedges') or old.get('graph',{}).get('hyperedges',[])
    ex={'nodes':ast['nodes']+semn,'edges':ast['edges']+seme,'hyperedges':semh,'input_tokens':0,'output_tokens':0}
    G=build_from_json(ex,root='.',directed=False)
    com=cluster(G);coh=score_all(G,com)
    oldlab={int(k):v for k,v in json.load(open('graphify-out/.graphify_labels.json')).items()}
    oldcom=collections.defaultdict(set)
    for n in old['nodes']:
        if n.get('community') is not None: oldcom[int(n['community'])].add(n['id'])
    lab={};used=collections.Counter()
    for k,v in com.items():
        sv=set(v);best=max(oldcom.items(),key=lambda kv:len(kv[1]&sv),default=(None,set()))
        l=oldlab.get(best[0]) if best[0] is not None and best[1]&sv else None
        if l and not l.startswith('Small group'):
            used[l]+=1; lab[k]=l if used[l]==1 else f"{l} ({used[l]})"
        else: lab[k]=("Small group: "+str(G.nodes[v[0]].get('label',v[0])))[:60]
    sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
    print('wrote',to_json(G,com,'graphify-out/graph.json',force=True,built_at_commit=sha,community_labels=lab))
    Path('graphify-out/GRAPH_REPORT.md').write_text(generate(G,com,coh,lab,god_nodes(G),surprising_connections(G,com),det,{'input':0,'output':0},'.',suggested_questions=suggest_questions(G,com,lab),built_at_commit=sha))
    Path('graphify-out/.graphify_labels.json').write_text(json.dumps({str(k):v for k,v in lab.items()},ensure_ascii=False))
    # save_manifest seeds from the existing manifest and prunes only files missing from disk,
    # so an excluded-but-present file stayed listed forever and read as "deleted" to
    # detect_incremental (50 of them by 2026-10-27). Rebuild it from the scan instead.
    Path('graphify-out/manifest.json').unlink(missing_ok=True)
    save_manifest(det['files'],root='.')
    big=[lab[k] for k in com if len(com[k])>=3 and lab[k].startswith('Small group')]
    print(G.number_of_nodes(),G.number_of_edges(),len(com),'unlabeled>=3:',len(big),big[:10])
    subprocess.run(['graphify','export','html'],check=True)
if __name__=='__main__': main()
