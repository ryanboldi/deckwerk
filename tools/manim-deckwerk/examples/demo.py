from manim import *

from manim_deckwerk import DeckSlide


class Demo(DeckSlide):
    def construct(self):
        self.name_slide("title")
        title = Text("Gradient descent", font_size=72)
        self.play(Write(title))

        self.next_slide(name="loss")
        self.play(title.animate.scale(0.6).to_edge(UP))
        ax = Axes(x_range=[-3, 3], y_range=[0, 9], x_length=8, y_length=4.5).shift(DOWN * 0.6)
        curve = ax.plot(lambda x: x**2, color=RED)
        self.play(Create(ax), Create(curve))

        self.next_slide(name="steps")
        dot = Dot(ax.c2p(2.6, 2.6**2), color=YELLOW)
        self.play(FadeIn(dot))
        x = 2.6
        for _ in range(4):
            x *= 0.5
            self.play(dot.animate.move_to(ax.c2p(x, x**2)), run_time=0.6)

        self.next_slide(name="rule")
        rule = MathTex(r"x \leftarrow x - \eta \nabla f(x)").to_edge(DOWN)
        self.play(Write(rule))

        self.next_slide(name="orbit", loop=True, notes="Loops until you advance.")
        self.play(Indicate(dot, scale_factor=1.8), run_time=1.2)
