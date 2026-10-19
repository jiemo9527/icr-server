import base64
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from fastapi.testclient import TestClient

import icr_server as server


def image_data(image):
    return base64.b64encode(cv2.imencode('.png', image)[1]).decode()


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        self.auth = patch.object(server, 'TOKEN', '')
        self.auth.start()
        self.addCleanup(self.auth.stop)
        self.image = image_data(np.full((40, 120, 3), 255, np.uint8))

    def test_ocr_rejects_conflict_and_passes_constraints(self):
        with patch('local_recognition.read_candidates', return_value=[('ab12', .99), ('abl2', .99)]):
            r = self.client.post('/ocr', json={'image': self.image}).json()
        self.assertFalse(r['ok'])
        self.assertEqual(r['reason'], 'model_conflict')

    def test_non_utf8_console_does_not_break_ocr_response(self):
        import io
        console=io.TextIOWrapper(io.BytesIO(),encoding='cp1252',errors='strict')
        with patch('sys.stdout',console), patch('local_recognition.read_candidates',return_value=[('ab12',.99),('abl2',.99)]):
            response=self.client.post('/ocr',json={'image':self.image})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['reason'],'model_conflict')

    def test_math_endpoint(self):
        with patch('local_recognition.read_candidates', return_value=[('12+7=?', .99)]*2):
            r = self.client.post('/math', json={'image': self.image}).json()
        self.assertTrue(r['ok'], r)
        self.assertEqual(r['text'], '19')

    def test_slider_endpoint_ignores_complete_background(self):
        rng = np.random.default_rng(9)
        full = rng.integers(0, 256, (100, 300, 3), np.uint8)
        bg = full.copy(); bg[30:60, 170:200] = 0
        r = self.client.post('/slider', json={'bg': image_data(bg), 'full': image_data(full)}).json()
        self.assertFalse(r['ok'], r)
        self.assertIn('滑块图片', r['msg'])

    def test_slider_sprite_crop_and_scale(self):
        rng=np.random.default_rng(41)
        bg=rng.integers(0,256,(100,300,3),np.uint8)
        sprite=np.zeros((180,180,4),np.uint8)
        sprite[60:90,70:100,:3]=bg[30:60,170:200];sprite[60:90,70:100,3]=255
        result=self.client.post('/slider',json={'bg':image_data(bg),'piece':image_data(sprite),
          'piece_crop':[65,55,40,40],'piece_scale':1.0}).json()
        self.assertTrue(result['ok'],result)
        self.assertEqual(result['piece_width'],40)
        self.assertEqual(result['piece_offset_left'],5)
        self.assertEqual(result['gap_left'],170)

    def test_validation_and_authentication(self):
        self.assertEqual(self.client.post('/ocr', json={'image': '%%%'}).status_code, 400)
        self.assertEqual(self.client.post('/ocr', json={'image': self.image, 'length': -1}).status_code, 422)
        with patch.object(server, 'TOKEN', 'unit-test'):
            self.assertEqual(self.client.post('/math', json={'image': self.image}).status_code, 401)
            self.assertEqual(self.client.post('/slider', json={'bg': self.image}).status_code, 401)
            self.assertEqual(self.client.post('/textclick', json={'bg': self.image, 'targets': '甲乙'}).status_code, 401)

    def test_textclick_endpoint(self):
        fake = {'ok': True, 'points': [[10.0, 20.0]], 'width': 120, 'height': 40, 'msg': ''}
        with patch('local_recognition.solve_text_click', return_value=fake) as solver:
            r = self.client.post('/textclick', json={'bg': self.image, 'targets': '请依次点击：驳 把 布'}).json()
        self.assertTrue(r['ok'], r)
        self.assertEqual(solver.call_args[0][1], ['驳', '把', '布'])
        bad = self.client.post('/textclick', json={'bg': self.image, 'targets': '请依次点击：'})
        self.assertEqual(bad.status_code, 400)

    def test_textclick_reads_targets_from_hint_image(self):
        fake = {'ok': True, 'points': [[10.0, 20.0]], 'width': 120, 'height': 40, 'msg': ''}
        with patch('local_recognition.read_hint_chars', return_value=(['铁', '翻'], {'texts': ['铁翻', '铁翻']})), \
             patch('local_recognition.solve_text_click', return_value=fake) as solver:
            r = self.client.post('/textclick', json={'bg': self.image, 'targets': '请依次点击:', 'hint_image': self.image}).json()
        self.assertTrue(r['ok'], r)
        self.assertEqual(solver.call_args[0][1], ['铁', '翻'])
        self.assertEqual(r['targets'], ['铁', '翻'])
        with patch('local_recognition.read_hint_chars', return_value=([], {'texts': ['二中白', '自']})):
            r = self.client.post('/textclick', json={'bg': self.image, 'hint_image': self.image}).json()
        self.assertFalse(r['ok'])
        self.assertEqual(r['reason'], 'hint_not_text')

    def test_health_advertises_all_endpoints(self):
        r = self.client.get('/health').json()
        self.assertTrue(r['auth_ok'])
        self.assertIn('/math', r['endpoints'])
        self.assertIn('/slider', r['endpoints'])
        self.assertIn('/textclick', r['endpoints'])


if __name__ == '__main__':
    unittest.main()
