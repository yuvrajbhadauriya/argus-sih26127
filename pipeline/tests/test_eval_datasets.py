"""Dataset loaders for the evaluation (offline: fixtures written to tmp_path)."""

import pytest

from eval import datasets as ds
from eval.images import image_size, synthetic_plate_png

# Real DataCluster VOC layout (number_plate_text attribute), trimmed.
DC_XML = """<annotation><folder>Datacluster</folder><filename>image_0030.jpg</filename>
<size><width>2448</width><height>3264</height></size>
<object><name>number_plate</name><truncated>0</truncated><occluded>0</occluded>
<bndbox><xmin>100.5</xmin><ymin>200</ymin><xmax>400.5</xmax><ymax>300</ymax></bndbox>
<attributes><attribute><name>rotation</name><value>15.0</value></attribute>
<attribute><name>number_plate_text</name><value>GJ01DY6855</value></attribute></attributes></object>
<object><name>number_plate</name><bndbox><xmin>1</xmin><ymin>1</ymin><xmax>5</xmax><ymax>5</ymax></bndbox>
<attributes><attribute><name>rotation</name><value>0.0</value></attribute></attributes></object>
</annotation>"""

NO_TEXT_XML = DC_XML.replace("<attribute><name>number_plate_text</name><value>GJ01DY6855</value></attribute>", "").replace(
    "image_0030", "image_0001")

SAI_XML = """<annotation><filename>car12.jpeg</filename>
<object><name>MH12DE1433</name><bndbox><xmin>10</xmin><ymin>20</ymin><xmax>110</xmax><ymax>50</ymax></bndbox></object>
</annotation>"""


def _png(path, text="AB12"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(synthetic_plate_png(text))


def test_datacluster_voc(tmp_path):
    (tmp_path / "Annotations").mkdir()
    (tmp_path / "Annotations" / "image_0030.xml").write_text(DC_XML)
    (tmp_path / "Annotations" / "image_0001.xml").write_text(NO_TEXT_XML)
    _png(tmp_path / "images" / "image_0030.jpg")
    _png(tmp_path / "images" / "image_0001.jpg")
    samples = ds.load_datacluster(str(tmp_path))
    assert len(samples) == 1  # image without plate text is not scored
    s = samples[0]
    assert s.plates == [{"text": "GJ01DY6855", "bbox": [100.5, 200.0, 300.0, 100.0]}]
    assert s.tags == {"angle": "label"}  # rotation >= 10 degrees


def test_saisirishan_voc_plate_in_name(tmp_path):
    (tmp_path / "annotations").mkdir()
    (tmp_path / "annotations" / "car12.xml").write_text(SAI_XML)
    _png(tmp_path / "images" / "car12.jpeg")
    (tmp_path / "annotations" / "cls.xml").write_text(SAI_XML.replace("MH12DE1433", "number_plate").replace("car12", "cls"))
    _png(tmp_path / "images" / "cls.jpeg")
    samples = ds.load_saisirishan(str(tmp_path))
    assert [s.plates[0]["text"] for s in samples] == ["MH12DE1433"]


def test_folder_labels_csv_with_conditions_and_boxes(tmp_path):
    _png(tmp_path / "night" / "f1.png")
    _png(tmp_path / "f2.png")
    (tmp_path / "labels.csv").write_text(
        "filename,plate_text,conditions,x,y,w,h\n"
        "night/f1.png,MH 02 AB 1234,rain;Motion-Blur,10,10,50,20\n"
        "f2.png,DL3CCD1210|MH01AA0001,,,,,\n"
        "missing.png,KA01AA0001,,,,,\n"
    )
    samples = {s.id: s for s in ds.folder_spec(str(tmp_path)).load(str(tmp_path))}
    assert set(samples) == {"night/f1", "f2"}
    f1 = samples["night/f1"]
    assert f1.plates == [{"text": "MH 02 AB 1234", "bbox": [10.0, 10.0, 50.0, 20.0]}]
    assert f1.tags == {"night": "label", "rain": "label", "blur": "label"}
    assert [p["text"] for p in samples["f2"].plates] == ["DL3CCD1210", "MH01AA0001"]


def test_labelled_dir_json_and_errors(tmp_path):
    _png(tmp_path / "a.png")
    (tmp_path / "gt.json").write_text('[{"image": "a.png", "text": "TN58AP5280", "weather": "fog"}]')
    [s] = ds.load_labelled_dir(str(tmp_path), "x")
    assert s.plates[0]["text"] == "TN58AP5280" and s.tags == {"fog": "label"}
    with pytest.raises(ds.DatasetUnavailable):
        ds.load_labelled_dir(str(tmp_path / "nope"), "x")


def test_benchmark_card_only_is_reported_clearly(monkeypatch, tmp_path):
    monkeypatch.setattr(ds, "hf_tree", lambda repo: [{"path": "README.md", "type": "file"}, {"path": ".gitattributes", "type": "file"}])
    with pytest.raises(ds.DatasetUnavailable, match="only its dataset card"):
        ds.download_benchmark(str(tmp_path))


def test_saisirishan_without_kaggle_explains_manual_steps(monkeypatch, tmp_path):
    monkeypatch.setattr(ds.shutil, "which", lambda _: None)
    with pytest.raises(ds.DatasetUnavailable, match="kaggle.json"):
        ds.download_saisirishan(str(tmp_path))


def test_synthetic_is_deterministic(tmp_path):
    a = ds.build_synthetic(str(tmp_path / "a"), n=6)
    b = ds.build_synthetic(str(tmp_path / "b"), n=6)
    assert [s.plates for s in a] == [s.plates for s in b]
    assert image_size(open(a[0].path, "rb").read())[0] > 50
    assert {"night": "label"} .items() <= a[2].tags.items()


def test_resolve_and_conditions():
    assert ds.resolve("datacluster").license.startswith("CC BY-NC-ND")
    assert ds.resolve("folder:/tmp/x").id == "folder:x"
    with pytest.raises(KeyError):
        ds.resolve("nope")
    assert ds.normalise_condition("Low Light") == "night"
    assert ds.normalise_condition("motion-blur") == "blur"
