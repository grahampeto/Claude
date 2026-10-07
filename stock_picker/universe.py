"""Default candidate universe: liquid US mid-cap names with a growth tilt.

This is only a seed list. The screen re-checks live market cap, so names that
have drifted out of the mid-cap band are dropped automatically. Pass your own
list with ``--tickers-file`` to screen a different universe.
"""

DEFAULT_UNIVERSE = [
    # Technology / software / semis
    "APPF", "BILL", "CFLT", "CIEN", "COHR", "CRDO", "CVLT", "CWAN", "DOCS", "DOCU",
    "DT", "DUOL", "ESTC", "FN", "FIVN", "GTLB", "GWRE", "HUBS", "IOT", "ITRI",
    "LSCC", "MANH", "MNDY", "MTSI", "NTNX", "NXT", "ONTO", "PATH", "PCOR", "PEGA",
    "PSTG", "QLYS", "RMBS", "S", "SITM", "SMAR", "SPSC", "TOST", "TWLO", "U",
    # Consumer
    "CAVA", "CELH", "CROX", "DECK", "DKS", "ELF", "FIVE", "HIMS", "ONON", "SFM",
    "SHAK", "TXRH", "WING", "WSM", "BROS", "RL", "SKX",
    # Health care
    "EXEL", "GMED", "HALO", "INSM", "ITCI", "MEDP", "NTRA", "PEN", "RVMD", "TMDX",
    "UTHR", "VKTX", "GKOS", "LNTH", "ALKS",
    # Industrials / energy transition
    "AAON", "AXON", "BWXT", "CW", "EME", "ESAB", "FIX", "GNRC", "ITT", "KNF",
    "MOD", "POWL", "RBC", "SAIA", "STRL", "TTEK", "WWD", "XPO", "VRT", "ATKR",
    # Financials / fintech
    "AFRM", "EVR", "HOOD", "IBKR", "LPLA", "SOFI", "TW", "COIN", "PJT",
]
