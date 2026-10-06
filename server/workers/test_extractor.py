"""Run: .venv/bin/python3 -B -m unittest discover -s server/workers -p 'test_*.py'."""
import contextlib
import io
import json
import os
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import Mock, patch

import extractor as ex
import numpy as np


class FeatureTests(unittest.TestCase):
    def test_energy_distinguishes_levels_and_is_duration_independent(self):
        levels = []
        for amplitude in (0.01, 0.03, 0.1, 0.3):
            audio = (amplitude * np.sin(2 * np.pi * 440 * np.arange(44100) / 44100)).astype('float32')
            level = ex.normalized_energy(audio)
            self.assertAlmostEqual(level, ex.normalized_energy(np.tile(audio, 15)))
            levels.append(level)
        self.assertEqual(levels, sorted(set(levels)))
        self.assertLess(levels[-1], 1)
        self.assertEqual(ex.normalized_energy(np.zeros(44100)), 0)
        with self.assertRaises(ValueError):
            ex.normalized_energy(np.array([np.nan]))

    def test_prediction_shape_and_finiteness(self):
        for values in ([], np.ones((1, 49)), np.full((1, 50), np.nan), np.full((1, 50), np.inf)):
            with self.subTest(shape=np.shape(values)), self.assertRaises(ValueError):
                ex.prediction_mean(values, 50, 'MusiCNN')
        np.testing.assert_allclose(ex.prediction_mean([[0]*50, [1]*50], 50, 'MusiCNN'), 0.5)

    def test_short_audio_is_repeated_for_models_only(self):
        source = np.arange(16000, dtype='float32')
        padded = ex.prepare_model_audio(source)
        self.assertEqual(len(padded), 48000)
        np.testing.assert_array_equal(padded[:16000], source)
        np.testing.assert_array_equal(padded[16000:32000], source)
        self.assertEqual(len(source), 16000)

    def test_pipeline_uses_dance_tag_and_one_decode(self):
        worker = ex.PersistentExtractor.__new__(ex.PersistentExtractor)
        worker.init_error = None
        worker.effnet_model = Mock(return_value=np.ones((2, 1280)))
        tags = np.zeros((2, 50))
        tags[:, 6], tags[:, 49] = 0.8, 0.1
        worker.musicnn_model = Mock(return_value=tags)
        worker.resampler = Mock(return_value=np.ones(16000, dtype='float32') * 0.1)
        worker.centroid = Mock(return_value=440)
        worker.complexity = Mock(return_value=(0, 0))
        worker.rhythm = Mock(side_effect=AssertionError('Short clips must not invent a tempo'))
        with patch.object(ex, 'probe_duration', return_value=1), patch.object(ex, 'decode_audio_window', return_value=np.ones(44100, dtype='float32') * 0.1) as decode:
            features = worker.extract_features('short.wav')['audioFeatures']
        decode.assert_called_once_with('short.wav', 44100, 0)
        self.assertEqual(features['acoustic_vector'][6], 0.8)
        self.assertEqual(features['bpm'], 0)
        self.assertAlmostEqual(np.linalg.norm(features['embedding_vector']), 1)
        self.assertEqual(features['feature_version'], 2)

    def test_protocol_does_not_reuse_previous_id_after_malformed_json(self):
        worker = Mock()
        worker.extract_features.return_value = {'audioFeatures': {}, 'timings': {}}
        output = io.StringIO()
        with patch.object(ex, 'PersistentExtractor', return_value=worker), patch('sys.stdin', io.StringIO('{"id":"first","filePath":"ok"}\ninvalid\n{"id":"second","filePath":"ok"}\n')), contextlib.redirect_stdout(output):
            ex.worker_mode('a', 'b')
        results = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([r['id'] for r in results], ['first', None, 'second'])
        self.assertIn('error', results[1])

    def test_decode_rejects_nonfinite_audio(self):
        result = Mock(stdout=np.full(5000, np.nan, dtype='<f4').tobytes())
        with patch.object(ex.subprocess, 'run', return_value=result), self.assertRaisesRegex(RuntimeError, 'non-finite'):
            ex.decode_audio_window('bad.wav', 44100, 0)

    def test_seek_stays_inside_file(self):
        self.assertEqual(ex.choose_analysis_start(1), 0)
        self.assertEqual(ex.choose_analysis_start(20), 5)
        self.assertEqual(ex.choose_analysis_start(3600), 1260)


@unittest.skipUnless(os.environ.get('AURORA_MODEL_TESTS') == '1', 'opt-in native model tests')
class NativeModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[2]
        cls.worker = ex.PersistentExtractor(str(root / 'server/models/msd-musicnn-1.pb'), str(root / 'server/models/discogs-effnet-bs64-1.pb'))
        cls.tmp = tempfile.TemporaryDirectory(prefix='aurora-extractor-test-')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_short_unicode_silent_and_repeated_jobs(self):
        for name, duration, amplitude in [("Bjørk.wav", 1, .1), ("em—dash.wav", .25, .03), ("artist's.wav", 15, .3), ('silence.wav', 1, 0), ('repeat.wav', 1, .1)]:
            with self.subTest(name=name):
                filepath = Path(self.tmp.name) / name
                audio = (amplitude * np.sin(2 * np.pi * 440 * np.arange(int(44100 * duration)) / 44100) * 32767).astype('<i2')
                with wave.open(str(filepath), 'wb') as output:
                    output.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
                    output.writeframes(audio.tobytes())
                result = self.worker.extract_features(str(filepath))
                features = result['audioFeatures']
                self.assertFalse(features['is_simulated'])
                self.assertEqual(len(features['embedding_vector']), 1280)
                self.assertEqual(len(features['acoustic_vector']), 8)
                self.assertTrue(np.isfinite(features['acoustic_vector']).all())
                json.dumps(result, allow_nan=False)
                if duration < 3:
                    self.assertEqual(features['bpm'], 0)
                if amplitude == 0:
                    self.assertEqual(features['acoustic_vector'][0], 0)


if __name__ == '__main__':
    unittest.main()
