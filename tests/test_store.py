import threading

from kokoro_reader import store


def test_concurrent_meta_updates_do_not_corrupt(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DOCS_DIR", tmp_path)
    d = tmp_path / "abc123"
    (d / "audio").mkdir(parents=True)
    store.save_meta(store.DocMeta(id="abc123", title="t", filename="f", created=0, segment_count=10))

    def hammer(n):
        for i in range(200):
            if n % 2:
                store.update_meta("abc123", position={"segment": i % 10, "offset": i * 1.2345})
            else:
                store.update_meta("abc123", voice="af_heart" if i % 2 else "jf_alpha")

    threads = [threading.Thread(target=hammer, args=(n,)) for n in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    meta = store.load_meta("abc123")  # raises if the JSON is damaged
    assert meta.segment_count == 10
    assert not list(d.glob("*.tmp"))
