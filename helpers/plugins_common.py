"""Helpers shared by the plugins."""
import sys


def open_slide(path, exact_dir):
    if exact_dir:
        if exact_dir not in sys.path:
            sys.path.insert(0, exact_dir)
        from util.slide_server import getSlideHandler  # EXACT's own reader selection: reads every format EXACT does

        return getSlideHandler(path)
    import openslide

    return openslide.OpenSlide(path)
