"""Select LIDC-IDRI nodules (>=3 readers, <=1.25 mm slices) that match Daniel's hard teaching cases."""
import numpy as np, pickle
import numpy.ma  # noqa: import before aliasing
np.int = int; np.float = float
import pylidc as pl

def rows():
    out = []
    for s in pl.query(pl.Scan).filter(pl.Scan.slice_thickness <= 1.25).all():
        try:
            nods = s.cluster_annotations(verbose=False)
        except Exception:
            continue
        for k, anns in enumerate(nods):
            if len(anns) < 3:
                continue
            med = lambda f: float(np.median([getattr(a, f) for a in anns]))
            out.append(dict(pid=s.patient_id, uid=s.series_instance_uid, k=k, readers=len(anns),
                            texture=med("texture"), spiculation=med("spiculation"), subtlety=med("subtlety"),
                            margin=med("margin"), diam=round(med("diameter"), 1), thick=s.slice_thickness))
    return out

if __name__ == "__main__":
    r = rows()
    pickle.dump(r, open("/tmp/lidc_rows.pkl", "wb"))
    print(len(r))
    show = lambda name, f: print(name, [(x["pid"], x["readers"], x["texture"], x["spiculation"], x["subtlety"], x["diam"]) for x in r if f(x)][:5])
    show("GGO", lambda x: x["texture"] <= 2 and 4 <= x["diam"] <= 9)
    show("part-solid", lambda x: x["texture"] == 3 and 7 <= x["diam"] <= 12)
    show("spiculated", lambda x: x["spiculation"] >= 4 and 9 <= x["diam"] <= 15 and x["texture"] == 5)
    show("solid small subtle", lambda x: x["texture"] == 5 and 6 <= x["diam"] <= 8 and x["subtlety"] <= 3)
    show("solid easy", lambda x: x["texture"] == 5 and 12 <= x["diam"] <= 16 and x["subtlety"] == 5 and x["spiculation"] <= 2)
