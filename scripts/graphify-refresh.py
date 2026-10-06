"""Refresh graphify-out/ after code changes without losing the full rebuild's doc work.

`graphify update .` re-adds stale per-heading doc nodes and unnames communities
(see CLAUDE.md "Knowledge Graph"). This instead combines a fresh AST extraction
of the code with the committed graph's doc nodes, drops nodes whose source file
no longer exists, and carries each community's name across by node overlap.

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
    import os
    gone=lambda sf: bool(sf) and not os.path.exists(sf if sf.startswith('/') else root+sf)
    semn=[n for n in old['nodes'] if n['id'] not in astids and not iscode(n.get('source_file')) and not gone(n.get('source_file'))]
    allids=astids|{n['id'] for n in semn}
    seme=[e for e in old[EL] if not iscode(e.get('source_file')) and not gone(e.get('source_file')) and e['source'] in allids and e['target'] in allids]
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
    save_manifest(det['files'],root='.')
    big=[lab[k] for k in com if len(com[k])>=3 and lab[k].startswith('Small group')]
    print(G.number_of_nodes(),G.number_of_edges(),len(com),'unlabeled>=3:',len(big),big[:10])
    subprocess.run(['graphify','export','html'],check=True)
if __name__=='__main__': main()
