from app import rating


def test_accuracy_averages_the_stored_classes_and_ignores_unknown_ones():
    assert rating.accuracy([]) is None  # ungraded is not 0%
    assert rating.accuracy(["brilliant", "brilliant"]) == 100
    assert rating.accuracy(["good", "inaccuracy"]) == 73  # (0.85 + 0.6) / 2, half-up
    assert rating.accuracy(["nonsense"]) is None


def test_grade_bands_are_the_documented_ladder():
    # Every boundary, so a band edit cannot silently shift the ladder by one point.
    bounds = (95, 90, 89, 80, 79, 70, 69, 60, 59, 50, 49)
    assert [rating.grade(a) for a in bounds] == ["S", "S", "A", "A", "B", "B", "C", "C", "D", "D", "F"]
    assert rating.grade(None) is None


def test_class_order_matches_its_point_values():
    # The badge ladder (best -> worst) and the numbers behind accuracy must not disagree.
    points = [rating.MOVE_POINTS[c] for c in rating.MOVE_CLASSES]
    assert points == sorted(points, reverse=True)
    assert rating.MOVE_POINTS["blunder"] == 0.0
