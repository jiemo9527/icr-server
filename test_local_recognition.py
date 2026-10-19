"""本地识别回归：不联网，模型输出用桩；图像匹配使用真实 OpenCV。"""
import unittest
from unittest.mock import patch

import cv2
import numpy as np

import local_recognition as lr


class OcrTests(unittest.TestCase):
    def predict(self, values, **options):
        with patch.object(lr, "read_candidates", return_value=values), \
             patch.object(lr, 'read_math_candidate', return_value=('', 0.0)):
            return lr.recognize_text(b"fixture", **options)

    def test_agreement_is_required(self):
        r = self.predict([("ab12", .98), ("abl2", .99)])
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "model_conflict")

    def test_agreed_text_is_accepted(self):
        r = self.predict([("ab12", .98), ("ab12", .97)], length=4)
        self.assertTrue(r["ok"])
        self.assertEqual(r["text"], "ab12")

    def test_invalid_characters_are_not_silently_removed(self):
        r = self.predict([("ab/12", .99)] * 2, charset="alnum")
        self.assertFalse(r["ok"])
        self.assertEqual(r["text"], "ab/12")

    def test_length_case_and_confidence(self):
        for kwargs in ({"length": 6}, {"case": "upper"}):
            self.assertFalse(self.predict([("ab12", .99)] * 2, **kwargs)["ok"])
        self.assertFalse(self.predict([("ab12", .3)] * 2)["ok"])
        self.assertTrue(self.predict([("AB12", .99)] * 2, case="upper")["ok"])

    def test_ordinary_x_is_not_math(self):
        r = self.predict([("2x3", .99)] * 2)
        self.assertEqual(r["kind"], "text")
        self.assertEqual(r["text"], "2x3")

    def test_auto_math_and_explicit_math(self):
        r = self.predict([("3+5=?", .99)] * 2)
        self.assertEqual((r["kind"], r["text"]), ("math", "8"))
        r = self.predict([("2x3", .99)] * 2, mode="math")
        self.assertEqual(r["text"], "6")

    def test_math_cross_engine_corroboration(self):
        with patch.object(lr, 'read_candidates', return_value=[('12+7=2', .98)] * 2), \
             patch.object(lr, 'read_math_candidate', return_value=('12+7=?', .99)):
            r = lr.recognize_text(b'fixture', mode='math')
        self.assertTrue(r['ok'], r)
        self.assertEqual(r['text'], '19')
        with patch.object(lr, 'read_candidates', return_value=[('12-7=2', .98)] * 2), \
             patch.object(lr, 'read_math_candidate', return_value=('12+7=?', .99)):
            self.assertFalse(lr.recognize_text(b'fixture', mode='math')['ok'])

    def test_math_candidates_must_agree_on_expression_not_answer(self):
        r = self.predict([("2+3=?", .99), ("1+4=?", .99)], mode="math")
        self.assertFalse(r["ok"])


class MathTests(unittest.TestCase):
    def test_safe_arithmetic(self):
        for s, answer in [("12＋7＝？", "19"), ("8×3=?", "24"), ("9÷3", "3"),
                          ("(2+3)*4", "20"), ("3-8=?", "-5"), ("1/4", "0.25")]:
            self.assertEqual(lr.calculate(s), answer)

    def test_unsupported_or_ambiguous_input_is_rejected(self):
        for s in ["__import__('os')", "2**100", "1/0", "2+", "三加五", "3+5=9", "9" * 100,
                  "10000*10000", "1/3", "(1+2", "1e3", "2//3"]:
            with self.subTest(s=s), self.assertRaises(ValueError):
                lr.calculate(s)


class SliderTests(unittest.TestCase):
    def fixture(self):
        rng = np.random.default_rng(42)
        bg = rng.integers(0, 256, (100, 300, 3), dtype=np.uint8)
        piece = np.zeros((50, 50, 4), np.uint8)
        piece[7:37, 9:39, :3] = bg[32:62, 173:203]
        piece[7:37, 9:39, 3] = 255
        return bg, piece

    def test_transparent_padding_and_unique_match(self):
        bg, piece = self.fixture()
        r = lr.match_slider(bg, piece=piece)
        self.assertTrue(r["ok"], r)
        self.assertAlmostEqual(r["gap_left"], 173, delta=1)
        self.assertEqual(r["piece_offset_left"], 9)

    def test_repeated_texture_is_rejected(self):
        bg, piece = self.fixture()
        bg[32:62, 230:260] = bg[32:62, 173:203]
        self.assertFalse(lr.match_slider(bg, piece=piece)["ok"])

    def test_blank_image_is_rejected(self):
        self.assertFalse(lr.match_slider(np.full((100, 300, 3), 255, np.uint8), piece=np.zeros((20, 20, 4), np.uint8))["ok"])

    def test_complete_background_is_not_supported(self):
        bg, piece = self.fixture()
        with self.assertRaises(TypeError):
            lr.match_slider(bg, piece=piece, full=bg)
        self.assertFalse(lr.match_slider(bg)["ok"])

    def shaded_gap_fixture(self, x=210, y=40, seed=7):
        """腾讯类：缺口是半透明暗色形状，滑块内容与缺口位置原图不同（被遮罩）。"""
        rng = np.random.default_rng(seed)
        base = cv2.GaussianBlur(rng.integers(60, 230, (180, 400, 3), dtype=np.uint8), (0, 0), 3)
        mask = np.zeros((44, 44), np.uint8)
        cv2.rectangle(mask, (0, 6), (37, 43), 255, -1)
        cv2.circle(mask, (19, 6), 6, 255, -1)
        cv2.circle(mask, (37, 25), 6, 255, -1)
        bg = base.copy()
        roi = bg[y:y + 44, x:x + 44].astype(np.float32)
        roi[mask > 0] = roi[mask > 0] * .35 + 15
        bg[y:y + 44, x:x + 44] = roi.astype(np.uint8)
        piece = np.zeros((60, 60, 4), np.uint8)
        piece[8:52, 8:52, :3] = rng.integers(0, 256, (44, 44, 3), dtype=np.uint8)
        piece[8:52, 8:52, 3] = mask
        return bg, piece

    def test_shaded_gap_found_by_shape_when_piece_content_differs(self):
        bg, piece = self.shaded_gap_fixture()
        r = lr.match_slider(bg, piece=piece)
        self.assertTrue(r['ok'], r)
        self.assertAlmostEqual(r['gap_left'], 210, delta=2)
        self.assertEqual(r['piece_offset_left'], 8)
        self.assertEqual(r['method'], 'shaded-shape')

    def test_two_shaded_gaps_are_rejected(self):
        bg, piece = self.shaded_gap_fixture()
        decoy, _ = self.shaded_gap_fixture(x=60, y=100)
        bg[100:144, 60:104] = decoy[100:144, 60:104]
        self.assertFalse(lr.match_slider(bg, piece=piece)['ok'])


class TextClickTests(unittest.TestCase):
    """文字点选：检测框 → 合并偏旁 → 每框对目标字的概率 → 全局最优分配；不确定就拒绝。"""
    img = np.full((240, 336, 3), 200, np.uint8)

    def run_with(self, boxes, scores, targets):
        def fake_scores(crop_box, _img, tgts):
            return {t: scores.get(tuple(crop_box), {}).get(t, 0.0) for t in tgts}
        with patch.object(lr, '_detect_char_boxes', return_value=boxes), \
             patch.object(lr, '_char_scores', side_effect=fake_scores):
            return lr.solve_text_click(self.img, targets)

    def test_merges_split_radicals_into_one_box(self):
        merged = lr.merge_char_boxes([(100, 20, 130, 70), (133, 22, 160, 70), (10, 100, 60, 150)])
        self.assertIn([100, 20, 160, 70], merged)
        self.assertEqual(len(merged), 2)

    def test_does_not_merge_two_far_characters(self):
        merged = lr.merge_char_boxes([(0, 0, 50, 50), (80, 0, 130, 50)])
        self.assertEqual(len(merged), 2)

    def test_assigns_targets_in_order_globally(self):
        boxes = [[0, 0, 50, 50], [100, 0, 150, 50], [200, 100, 250, 150]]
        scores = {(0, 0, 50, 50): {'甲': .9}, (100, 0, 150, 50): {'乙': .02},
                  (200, 100, 250, 150): {'丙': .8, '乙': .01}}
        r = self.run_with(boxes, scores, ['丙', '甲', '乙'])
        self.assertTrue(r['ok'], r)
        self.assertEqual(r['points'], [[225.0, 125.0], [25.0, 25.0], [125.0, 25.0]])
        self.assertEqual((r['width'], r['height']), (336, 240))

    def test_rejects_when_too_few_boxes(self):
        r = self.run_with([[0, 0, 50, 50]], {}, ['甲', '乙'])
        self.assertFalse(r['ok'])
        self.assertIn('文字', r['msg'])

    def test_rejects_when_no_target_recognized(self):
        boxes = [[0, 0, 50, 50], [100, 0, 150, 50], [200, 100, 250, 150]]
        r = self.run_with(boxes, {}, ['甲', '乙', '丙'])
        self.assertFalse(r['ok'])

    def test_rejects_ambiguous_assignment(self):
        boxes = [[0, 0, 50, 50], [100, 0, 150, 50]]
        scores = {(0, 0, 50, 50): {'甲': .5, '乙': .5}, (100, 0, 150, 50): {'甲': .5, '乙': .5}}
        r = self.run_with(boxes, scores, ['甲', '乙'])
        self.assertFalse(r['ok'])

    def test_hint_image_chars_require_agreement_and_confidence(self):
        img = np.zeros((20, 60, 4), np.uint8)
        def fake(results):
            it = iter(results)
            class M:
                def classification(self, raw, probability=False):
                    return next(it)
            return lambda beta: M()
        ok = [{'text': '铁翻顺', 'confidence': .98}, {'text': '铁翻顺', 'confidence': .95}]
        with patch.object(lr, '_model', side_effect=fake(ok)):
            self.assertEqual(lr.read_hint_chars(img)[0], ['铁', '翻', '顺'])
        one_diff = [{'text': '苔返园筷', 'confidence': .99}, {'text': '爷返园筷', 'confidence': .92}]
        with patch.object(lr, '_model', side_effect=fake(one_diff)):
            self.assertEqual(lr.read_hint_chars(img)[0], ['苔', '返', '园', '筷'])
        for bad in ([{'text': '二中白', 'confidence': .94}, {'text': '自', 'confidence': .87}],      # 图标条：字数不一致
                    [{'text': '甲乙', 'confidence': .5}, {'text': '甲乙', 'confidence': .9}],          # 置信度低
                    [{'text': 'a自', 'confidence': .99}, {'text': 'a自', 'confidence': .99}],          # 含非汉字
                    [{'text': '甲乙丙', 'confidence': .99}, {'text': '丁戊丙', 'confidence': .99}]):   # 两字以上不同
            with patch.object(lr, '_model', side_effect=fake(bad)):
                self.assertEqual(lr.read_hint_chars(img)[0], [], bad)

    def test_char_scores_tries_rotations_and_ink_mask(self):
        seen = []
        class M:
            def classification(self, raw, probability=False):
                seen.append(len(raw))
                return {'charset': ['', '甲'], 'probabilities': [[.9, .1]], 'text': '', 'confidence': .1}
        with patch.object(lr, '_model', return_value=M()):
            r = lr._char_scores([10, 10, 50, 50], np.full((80, 80, 3), 180, np.uint8), ['甲', '乙'])
        self.assertEqual(r, {'甲': .10000000149011612, '乙': 0.0})
        # 原图 + 抠字图，各 2 个模型 + 6 个角度
        self.assertEqual(len(seen), 2 * (2 + len(lr.TEXT_CLICK_ANGLES)))

    def test_target_parsing_accepts_prompt_text(self):
        self.assertEqual(lr.parse_click_targets('请依次点击：驳 把 布'), ['驳', '把', '布'])
        self.assertEqual(lr.parse_click_targets('驳把布'), ['驳', '把', '布'])
        self.assertEqual(lr.parse_click_targets('请依次点击：'), [])


if __name__ == "__main__":
    unittest.main()
