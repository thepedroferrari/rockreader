from kokoro_reader.extract import MAX_SEGMENT_CHARS, clean_text, segment


def test_dehyphenates_and_joins_lines():
    raw = "This is informa-\ntion that wraps\nacross lines.\n\nNext paragraph."
    assert clean_text(raw) == "This is information that wraps across lines.\n\nNext paragraph."


def test_drops_page_numbers_and_citations():
    raw = "Some claim [12] holds.\n\n42\n\nMore text [3, 4]."
    assert clean_text(raw) == "Some claim holds.\n\nMore text."


def test_short_headings_merge_into_next_segment():
    segs = segment("Introduction\n\n" + "A proper paragraph of enough length to stand on its own here.")
    assert segs == ["Introduction. A proper paragraph of enough length to stand on its own here."]


def test_long_paragraph_splits_on_sentences():
    sentence = "This sentence is here to make the paragraph long enough to split. "
    segs = segment(sentence * 30)
    assert len(segs) > 1
    assert all(len(s) <= MAX_SEGMENT_CHARS + 5 for s in segs)
    assert all(s.endswith(".") for s in segs)


def test_strips_emails():
    assert clean_text("Contact me at someone@example.com for details.") == "Contact me at for details."
