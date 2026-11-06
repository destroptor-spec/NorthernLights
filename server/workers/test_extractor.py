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

    @staticmethod
    def _worker(embeddings=None, styles=None, descriptors=None):
        worker = ex.PersistentExtractor.__new__(ex.PersistentExtractor)
        worker.init_error = None
        output = ex.ModelOutput(
            np.ones((2, 1280)) if embeddings is None else embeddings,
            np.full((2, 400), 0.25) if styles is None else styles,
            descriptors or {'danceability': np.array([0.8, 0.8]), 'acousticness': np.array([0.1, 0.3]),
                            'instrumentalness': np.array([0.9, 0.7])},
            {'effnet_ms': 1.0},
        )
        worker.backend = Mock(infer=Mock(return_value=output))
        worker.resampler = Mock(side_effect=lambda audio: np.ones(len(audio) * 16000 // 44100, dtype='float32') * 0.1)
        worker.centroid = Mock(return_value=440)
        worker.complexity = Mock(return_value=(0, 0))
        worker.rhythm = Mock(side_effect=AssertionError('Short clips must not invent a tempo'))
        return worker

    def test_short_track_uses_one_unpadded_window(self):
        worker = self._worker()
        with patch.object(ex, 'probe_duration', return_value=1), patch.object(ex, 'decode_audio_window', return_value=np.ones(44100, dtype='float32') * 0.1) as decode:
            features = worker.extract_features('short.wav')['audioFeatures']
        decode.assert_called_once_with('short.wav', 44100, 0.0)
        # [.., instrumental, acoustic, danceability, ..] come from the EffNet classifiers.
        self.assertAlmostEqual(features['acoustic_vector'][4], 0.8)
        self.assertAlmostEqual(features['acoustic_vector'][5], 0.2)
        self.assertAlmostEqual(features['acoustic_vector'][6], 0.8)
        worker.resampler.assert_called_once()
        self.assertEqual(features['bpm'], 0)
        self.assertAlmostEqual(np.linalg.norm(features['embedding_vector']), 1)
        self.assertEqual(len(features['style_scores']), 400)
        self.assertEqual(features['style_scores'][0], 0.25)
        self.assertEqual(features['analysis_windows'], '1x15s@0%')
        self.assertEqual(features['feature_version'], 3)

    def test_three_windows_share_one_decode_and_one_inference(self):
        worker = self._worker()
        worker.rhythm = Mock(return_value=(120.0,))
        windows = [np.full(5 * 44100, level, dtype='float32') for level in (0.1, 0.2, 0.3)]
        clips = [np.full(5 * 16000, level, dtype='float32') for level in (0.1, 0.2, 0.3)]
        with patch.object(ex, 'probe_duration', side_effect=AssertionError('duration from the job must skip ffprobe')), \
                patch.object(ex, 'decode_audio_windows', return_value=(windows, clips)) as decode:
            result = worker.extract_features('long.flac', 100.0)
        features = result['audioFeatures']
        decode.assert_called_once_with('long.flac', [20.0, 50.0, 80.0])
        self.assertIs(worker.backend.infer.call_args.args[0], clips)
        worker.resampler.assert_not_called()  # ffmpeg already produced the 16 kHz clips
        worker.backend.infer.assert_called_once()
        # Tempo comes from the middle window only.
        np.testing.assert_array_equal(worker.rhythm.call_args.args[0], windows[1])
        self.assertEqual(worker.complexity.call_count, 3)
        self.assertEqual(features['bpm'], 120)
        self.assertEqual(features['analysis_windows'], '3x15s@20/50/80%')
        self.assertNotIn('duration_probe_ms', result['timings'])

    def test_descriptors_must_be_probabilities(self):
        worker = self._worker(descriptors={'danceability': np.array([1.2]), 'acousticness': np.array([0.1]),
                                           'instrumentalness': np.array([0.1])})
        with patch.object(ex, 'probe_duration', return_value=1), patch.object(ex, 'decode_audio_window', return_value=np.ones(44100, dtype='float32') * 0.1), \
                self.assertRaisesRegex(ValueError, 'danceability'):
            worker.extract_features('short.wav')

    def test_style_scores_must_be_probabilities(self):
        worker = self._worker(styles=np.full((2, 400), 1.5))
        with patch.object(ex, 'probe_duration', return_value=1), patch.object(ex, 'decode_audio_window', return_value=np.ones(44100, dtype='float32') * 0.1), \
                self.assertRaisesRegex(ValueError, 'Style head'):
            worker.extract_features('short.wav')

    def test_protocol_does_not_reuse_previous_id_after_malformed_json(self):
        worker = Mock()
        worker.extract_features.return_value = {'audioFeatures': {}, 'timings': {}}
        output = io.StringIO()
        jobs = '{"id":"first","filePath":"ok","durationSeconds":200}\ninvalid\n{"id":"second","filePath":"ok"}\n'
        with patch.object(ex, 'PersistentExtractor', return_value=worker), patch('sys.stdin', io.StringIO(jobs)), contextlib.redirect_stdout(output):
            ex.worker_mode('models')
        results = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([r['id'] for r in results], ['first', None, 'second'])
        self.assertIn('error', results[1])
        self.assertEqual([c.args for c in worker.extract_features.call_args_list], [('ok', 200), ('ok', None)])

    def test_decode_rejects_nonfinite_audio(self):
        result = Mock(stdout=np.full(5000, np.nan, dtype='<f4').tobytes())
        with patch.object(ex.subprocess, 'run', return_value=result), self.assertRaisesRegex(RuntimeError, 'non-finite'):
            ex.decode_audio_window('bad.wav', 44100, 0)

    def test_window_decode_splits_one_stream_by_sample_count(self):
        hi, lo = int(ex.ANALYSIS_DURATION_SECONDS * 44100), int(ex.ANALYSIS_DURATION_SECONDS * 16000)
        # Stream layout: three 44.1 kHz windows, then the same three at 16 kHz.
        stream = np.concatenate([np.full(hi, v, dtype='<f4') for v in (0.1, 0.2, 0.3)]
                                + [np.full(lo, v, dtype='<f4') for v in (0.4, 0.5, 0.6)])
        with patch.object(ex.subprocess, 'run', return_value=Mock(stdout=stream.tobytes())) as run:
            windows, clips = ex.decode_audio_windows('x.flac', [20.0, 50.0, 80.0])
        run.assert_called_once()
        args = run.call_args.args[0]
        self.assertEqual(args.count('-i'), 3)
        self.assertEqual([len(w) for w in windows], [hi] * 3)
        self.assertEqual([len(c) for c in clips], [lo] * 3)
        self.assertEqual([float(w[0]) for w in windows], [np.float32(0.1), np.float32(0.2), np.float32(0.3)])
        self.assertEqual([float(c[0]) for c in clips], [np.float32(0.4), np.float32(0.5), np.float32(0.6)])
        with patch.object(ex.subprocess, 'run', return_value=Mock(stdout=stream[:-10].tobytes())), self.assertRaisesRegex(RuntimeError, 'expected'):
            ex.decode_audio_windows('x.flac', [20.0, 50.0, 80.0])

    def test_single_window_is_decoded_unpadded_without_16k_branch(self):
        with patch.object(ex, 'decode_audio_window', return_value=np.ones(4410, dtype='float32')) as decode:
            windows, clips = ex.decode_audio_windows('short.wav', [0.0])
        decode.assert_called_once_with('short.wav', 44100, 0.0)
        self.assertIsNone(clips)
        self.assertEqual(len(windows[0]), 4410)

    def test_windows_stay_inside_file(self):
        self.assertEqual(ex.choose_analysis_starts(None), [0.0])
        self.assertEqual(ex.choose_analysis_starts(1), [0.0])
        self.assertEqual(ex.choose_analysis_starts(20), [4.0, 5.0, 5.0])
        self.assertEqual(ex.choose_analysis_starts(3600), [720.0, 1800.0, 2880.0])


@unittest.skipUnless(os.environ.get('AURORA_MODEL_TESTS') == '1', 'opt-in native model tests')
class NativeModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[2]
        cls.worker = ex.PersistentExtractor(str(root / 'server/models'))
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
                self.assertEqual(len(features['style_scores']), 400)
                if duration < 3:
                    self.assertEqual(features['bpm'], 0)
                if amplitude == 0:
                    self.assertEqual(features['acoustic_vector'][0], 0)

    def test_long_track_decodes_three_windows(self):
        filepath = Path(self.tmp.name) / 'long track — Ærø.wav'
        seconds = 75
        t = np.arange(44100 * seconds) / 44100
        audio = (0.2 * np.sin(2 * np.pi * (220 + 4 * t) * t) * 32767).astype('<i2')
        with wave.open(str(filepath), 'wb') as output:
            output.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
            output.writeframes(audio.tobytes())
        result = self.worker.extract_features(str(filepath), float(seconds))
        features = result['audioFeatures']
        self.assertEqual(features['analysis_windows'], '3x15s@20/50/80%')
        self.assertEqual(result['timings']['analysis_starts_seconds'], [15.0, 37.5, 60.0])
        self.assertEqual(len(features['style_scores']), 400)
        self.assertAlmostEqual(np.linalg.norm(features['embedding_vector']), 1, places=5)
        json.dumps(result, allow_nan=False)


if __name__ == '__main__':
    unittest.main()
