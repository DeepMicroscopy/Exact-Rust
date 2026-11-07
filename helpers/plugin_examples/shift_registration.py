"""Example registration plugin: a "registration" that is only a shift. It shows the whole interface in 25 lines.

A registration plugin returns the matrix that maps pixels of the SOURCE image onto the TARGET image (t_00 ... t_22, row by row), the
mean error in target pixels and the time it took. A real plugin would look at both images; this one moves everything by `shift_x`, `shift_y`.

    python helpers/queue_worker.py --url http://localhost:8002 --user worker --password ... --plugins helpers/plugin_examples --only shift
"""
import sys

sys.path.insert(0, __file__.rsplit("/", 2)[0])
from queue_plugin import RegistrationPlugin, RegistrationResult, param  # noqa: E402


class ShiftRegistration(RegistrationPlugin):
    name = "Example: fixed shift"
    package = "org.example.fixed-shift"
    parameters = [
        param("shift_x", "float", 100.0, "Shift x", "pixels to the right", min=-100000, max=100000),
        param("shift_y", "float", 0.0, "Shift y", "pixels down", min=-100000, max=100000),
    ]

    def register(self, source_path, target_path, params, ctx):
        # source_path and target_path are files on the server; open them with plugins_common.open_slide if you need pixels
        matrix = {"t_00": 1.0, "t_01": 0.0, "t_02": params["shift_x"],
                  "t_10": 0.0, "t_11": 1.0, "t_12": params["shift_y"],
                  "t_20": 0.0, "t_21": 0.0, "t_22": 1.0}
        return RegistrationResult(matrix=matrix, error=0.0, runtime=0)


PLUGINS = [ShiftRegistration()]
