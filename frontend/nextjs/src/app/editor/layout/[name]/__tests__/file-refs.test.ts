import { collectFileIds, unreferencedFileIds } from '../file-refs';

const file = (name: string) => new File(['x'], name, { type: 'image/jpeg', lastModified: 1 });

describe('collectFileIds', () => {
  it('finds fileIds on frames, image overlays and held-out book pages', () => {
    const editorState = {
      surfaces: [{
        key: 'front',
        canvases: [{
          frames: [{ fileId: 'a' }, { fileId: 'b' }, {}],
          overlays: [{ type: 'image', fileId: 'c' }, { type: 'text', text: 'hi' }],
        }],
      }],
      bookState: { hiddenSurfaces: [{ key: 'page_09', canvases: [{ frames: [{ fileId: 'd' }], overlays: [] }] }] },
    };
    expect(collectFileIds(editorState)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('ignores empty and non-string fileIds', () => {
    expect(collectFileIds([{ fileId: '' }, { fileId: null }, { fileId: 7 }])).toEqual(new Set());
  });

  it('does not walk into File contents, and survives cycles', () => {
    const node: Record<string, unknown> = { fileId: 'a', originalFile: file('p.jpg') };
    node.self = node;
    expect(collectFileIds(node)).toEqual(new Set(['a']));
  });

  it('maps a File still in state to its id even when the frame lost its fileId', () => {
    const photo = file('p.jpg');
    const ids = new WeakMap<File, string>([[photo, 'kept']]);
    const state = [{ canvases: [{ frames: [{ originalFile: photo }], overlays: [] }] }];
    const found = collectFileIds(state, new Set(), b => (b instanceof File ? ids.get(b) : undefined));
    expect(found).toEqual(new Set(['kept']));
  });
});

describe('unreferencedFileIds', () => {
  it('returns only the known ids that no source names', () => {
    const saved = { surfaces: [{ canvases: [{ frames: [{ fileId: 'a' }], overlays: [] }] }] };
    const current = [{ canvases: [{ frames: [{ fileId: 'b' }], overlays: [] }] }];
    expect(unreferencedFileIds(['a', 'b', 'c'], [saved, current])).toEqual(['c']);
  });

  it('keeps an id referenced by any one source', () => {
    expect(unreferencedFileIds(['a'], [{}, { fileId: 'a' }])).toEqual([]);
  });

  it('with nothing referenced, every known id is unreferenced', () => {
    expect(unreferencedFileIds(['a', 'b'], [{ surfaces: [] }])).toEqual(['a', 'b']);
  });
});
